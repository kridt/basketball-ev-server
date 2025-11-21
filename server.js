// server.js
require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cron = require("node-cron");
const { computePropProb } = require("./evCalculator");
const {
  computePlayerPropProb,
  computeMatchStatProb,
} = require("./evCalculatorFootball");

const app = express();
app.use(express.json());

// ---------------- CACHE STORAGE ----------------
const cache = {
  epl: {
    data: null,
    lastUpdated: null,
    isLoading: false,
  },
  nba: {
    data: null,
    lastUpdated: null,
    isLoading: false,
  },
};

const API_KEY = process.env.BALLDONTLIE_API_KEY;
const BASE_URL =
  process.env.BALLDONTLIE_BASE_URL || "https://api.balldontlie.io/v1";
const API_BASE = "https://api.balldontlie.io"; // Base without /v1 for EPL
const CURRENT_SEASON = Number(process.env.NBA_SEASON || 2025);
const CURRENT_EPL_SEASON = Number(process.env.EPL_SEASON || 2025);
const PORT = process.env.PORT || 4000;

if (!API_KEY) {
  console.warn("WARNING: BALLDONTLIE_API_KEY is not set in .env");
}

// ---------------- CORS SETUP ----------------

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// ---------------- HEALTH CHECK ----------------

app.get("/health", (req, res) => {
  res.json({ ok: true, season: CURRENT_SEASON });
});

// ---------------- MODEL CONFIG ----------------

// Supported stat keys
const STAT_KEYS = ["pts", "reb", "ast", "fg3m", "pra", "pr", "pa", "ra"];

const statExtractors = {
  pts: (s) => s.pts,
  reb: (s) => s.reb,
  ast: (s) => s.ast,
  fg3m: (s) => s.fg3m,
  pra: (s) => s.pts + s.reb + s.ast,
  pr: (s) => s.pts + s.reb,
  pa: (s) => s.pts + s.ast,
  ra: (s) => s.reb + s.ast,
};

// ---------------- HELPERS: BALDONTLIE ----------------

async function bdFetch(url) {
  const res = await fetch(url, {
    headers: { Authorization: API_KEY },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`balldontlie error ${res.status}: ${text}`);
  }
  return res.json();
}

// 1) Get next N games (from today forward in CET timezone, regular season only)
async function fetchNextGames(limit = 10) {
  // Get current date in CET (Europe/Paris) timezone
  const nowCET = new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" });
  const cetDate = new Date(nowCET);

  // Start from yesterday to ensure we catch all games happening "today" in CET
  const yesterday = new Date(cetDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const startDate = yesterday.toISOString().slice(0, 10); // YYYY-MM-DD

  const url = new URL(`${BASE_URL}/games`);
  url.searchParams.append("start_date", startDate);
  url.searchParams.append("seasons[]", CURRENT_SEASON);
  url.searchParams.append("per_page", limit * 2); // Fetch more to filter client-side
  url.searchParams.append("postseason", "false");

  const json = await bdFetch(url.toString());

  // Filter to only include games that haven't started yet in CET
  const now = Date.now();
  const upcomingGames = (json.data || []).filter(game => {
    const gameTime = new Date(game.datetime).getTime();
    return gameTime > now;
  });

  // Return only the requested number of upcoming games
  return upcomingGames.slice(0, limit);
}

// 2) Get all players for a given team
async function fetchPlayersForTeam(teamId) {
  const players = [];
  let cursor = undefined;

  while (true) {
    const url = new URL(`${BASE_URL}/players`);
    url.searchParams.append("team_ids[]", teamId);
    url.searchParams.append("per_page", 100);
    if (cursor !== undefined) {
      url.searchParams.append("cursor", cursor);
    }

    const json = await bdFetch(url.toString());
    if (json.data && json.data.length) {
      players.push(...json.data);
    }

    if (json.meta && json.meta.next_cursor) {
      cursor = json.meta.next_cursor;
    } else {
      break;
    }
  }

  return players;
}

// 3) Get full season stats for a player (regular season)
async function fetchPlayerStatsSeason(playerId) {
  const url = new URL(`${BASE_URL}/stats`);
  url.searchParams.append("seasons[]", CURRENT_SEASON);
  url.searchParams.append("player_ids[]", playerId);
  url.searchParams.append("per_page", 100);
  url.searchParams.append("postseason", "false");

  const json = await bdFetch(url.toString());
  return json.data || [];
}

// Sort stats by date (newest first)
function sortStatsByDate(stats) {
  return [...stats].sort(
    (a, b) => new Date(b.game.date) - new Date(a.game.date)
  );
}

// Build numeric arrays for one stat key
function buildStatSeries(stats, key) {
  const extractor = statExtractors[key];
  if (!extractor) return [];
  return stats.map((s) => extractor(s)).filter((v) => v != null);
}

// Generate bets for one player & one stat key
function generateBetsForSeries({
  seasonValues,
  recentValues,
  player,
  statKey,
  minProb,
  maxProb,
  weightRecent,
}) {
  const bets = [];
  if (seasonValues.length < 8) {
    // too little data, skip
    return bets;
  }

  // Quick call to get mu & sigma (line doesn't matter for this)
  const base = computePropProb({
    seasonValues,
    recentValues,
    line: 0,
    side: "over",
    weightRecent,
  });

  const mu = base.mu;
  const sigma = base.sigma;

  if (!isFinite(mu) || !isFinite(sigma) || sigma <= 0) {
    return bets;
  }

  // Scan candidate lines around mean: [mu-8, mu+8] step 0.5 (clamped >= 0)
  const startLine = Math.max(0, Math.floor(mu - 8));
  const endLine = Math.floor(mu + 8);
  const step = 0.5;

  for (let line = startLine; line <= endLine; line += step) {
    // Over
    const overRes = computePropProb({
      seasonValues,
      recentValues,
      line,
      side: "over",
      weightRecent,
    });

    const overP = overRes.p;
    if (overP >= minProb && overP <= maxProb) {
      bets.push({
        playerId: player.id,
        playerName: `${player.first_name} ${player.last_name}`,
        stat: statKey,
        side: "over",
        line: Number(line.toFixed(1)),
        probability: overP,
        fairOdds: overRes.fairOdds,
        seasonAvg: overRes.seasonAvg,
        recentAvg: overRes.recentAvg,
        sigma: overRes.sigma,
      });
    }

    // Under
    const underRes = computePropProb({
      seasonValues,
      recentValues,
      line,
      side: "under",
      weightRecent,
    });

    const underP = underRes.p;
    if (underP >= minProb && underP <= maxProb) {
      bets.push({
        playerId: player.id,
        playerName: `${player.first_name} ${player.last_name}`,
        stat: statKey,
        side: "under",
        line: Number(line.toFixed(1)),
        probability: underP,
        fairOdds: underRes.fairOdds,
        seasonAvg: underRes.seasonAvg,
        recentAvg: underRes.recentAvg,
        sigma: underRes.sigma,
      });
    }
  }

  // Sort by probability desc, then return top few for this stat
  bets.sort((a, b) => b.probability - a.probability);
  return bets.slice(0, 2); // prevent explosion per player/stat
}

// Generate bets for a player across all stat keys
function generateBetsForPlayer({
  stats,
  player,
  minProb,
  maxProb,
  weightRecent,
  recentGames = 5,
}) {
  const bets = [];
  if (!stats.length) return bets;

  const sorted = sortStatsByDate(stats);
  const recent = sorted.slice(0, recentGames);

  for (const key of STAT_KEYS) {
    const seasonValues = buildStatSeries(sorted, key);
    const recentValues = buildStatSeries(recent, key);

    if (seasonValues.length < 8) continue;

    const statBets = generateBetsForSeries({
      seasonValues,
      recentValues,
      player,
      statKey: key,
      minProb,
      maxProb,
      weightRecent,
    });

    bets.push(...statBets);
  }

  return bets;
}

// ---------------- STATS ENDPOINT FOR RESULT VERIFICATION ----------------
//
// GET /api/player-stats?game_id=123&player_id=456
// Fetches completed game stats for a specific player
//
app.get("/api/player-stats", async (req, res) => {
  const gameId = req.query.game_id;
  const playerId = req.query.player_id;

  if (!gameId || !playerId) {
    return res.status(400).json({
      error: "Missing required parameters",
      details: "Both game_id and player_id are required",
    });
  }

  try {
    console.log(`Fetching stats for player ${playerId} in game ${gameId}...`);

    const url = new URL(`${BASE_URL}/stats`);
    url.searchParams.append("game_ids[]", gameId);
    url.searchParams.append("player_ids[]", playerId);
    url.searchParams.append("per_page", 1); // We only need one result

    const json = await bdFetch(url.toString());

    if (!json.data || json.data.length === 0) {
      return res.status(404).json({
        error: "Stats not found",
        details: `No stats found for player ${playerId} in game ${gameId}`,
      });
    }

    const stats = json.data[0];

    // Return formatted stats
    res.json({
      success: true,
      data: {
        gameId: stats.game.id,
        playerId: stats.player.id,
        playerName: `${stats.player.first_name} ${stats.player.last_name}`,
        gameDate: stats.game.date,
        minutesPlayed: stats.min,
        stats: {
          pts: stats.pts || 0,
          reb: stats.reb || 0,
          ast: stats.ast || 0,
          fg3m: stats.fg3m || 0,
          pra: (stats.pts || 0) + (stats.reb || 0) + (stats.ast || 0),
          pr: (stats.pts || 0) + (stats.reb || 0),
          pa: (stats.pts || 0) + (stats.ast || 0),
          ra: (stats.reb || 0) + (stats.ast || 0),
        },
      },
    });
  } catch (err) {
    console.error("Error fetching player stats:", err);
    res.status(500).json({ error: "Internal error", details: err.message });
  }
});

// ---------------- MAIN ENDPOINT ----------------
//
// GET /api/recommended-bets?minProb=0.58&maxProb=0.62&perGame=5&games=2&maxPlayersPerTeam=6
//
app.get("/api/recommended-bets", async (req, res) => {
  // Default: narrow window around 60% probability
  const minProb = req.query.minProb ? Number(req.query.minProb) : 0.58; // ~58% lower bound

  const maxProb = req.query.maxProb ? Number(req.query.maxProb) : 0.62; // ~62% upper bound

  const perGame = req.query.perGame ? Number(req.query.perGame) : 5;

  // How many games and players to scan
  const gameLimit = req.query.games ? Number(req.query.games) : 5; // default: 5 games
  const maxPlayersPerTeam = req.query.maxPlayersPerTeam
    ? Number(req.query.maxPlayersPerTeam)
    : 6; // default: 6 players per team

  const weightRecent = 0.65; // 65% form / 35% season
  const recentGames = 5;

  try {
    console.log(
      `Fetching next ${gameLimit} games for season ${CURRENT_SEASON}...`
    );
    const games = await fetchNextGames(gameLimit);

    const result = [];

    for (const game of games) {
      console.log(
        `Processing game ${game.id}: ${game.visitor_team.full_name} @ ${game.home_team.full_name}`
      );

      const homeId = game.home_team.id;
      const awayId = game.visitor_team.id;

      // Fetch players for both teams
      const [homePlayersAll, awayPlayersAll] = await Promise.all([
        fetchPlayersForTeam(homeId),
        fetchPlayersForTeam(awayId),
      ]);

      // Limit number of players per team for speed
      const homePlayers = homePlayersAll.slice(0, maxPlayersPerTeam);
      const awayPlayers = awayPlayersAll.slice(0, maxPlayersPerTeam);
      const allPlayers = [...homePlayers, ...awayPlayers];

      console.log(
        `Using ${homePlayers.length} home + ${awayPlayers.length} away players for game ${game.id}`
      );

      const allBets = [];

      // Fetch stats for all players in parallel
      const statPromises = allPlayers.map(async (player) => {
        try {
          const stats = await fetchPlayerStatsSeason(player.id);
          if (stats.length < 8) {
            // too few games, skip
            return;
          }

          const bets = generateBetsForPlayer({
            stats,
            player,
            minProb,
            maxProb,
            weightRecent,
            recentGames,
          });

          if (bets.length) {
            allBets.push(...bets);
          }
        } catch (e) {
          console.error(
            `Error processing player ${player.id} (${player.first_name} ${player.last_name}):`,
            e.message
          );
        }
      });

      await Promise.all(statPromises);

      // Sort bets for this game by probability desc
      allBets.sort((a, b) => b.probability - a.probability);

      const topBets = allBets.slice(0, perGame);

      result.push({
        gameId: game.id,
        date: game.date,
        datetime: game.datetime,
        home_team: game.home_team,
        visitor_team: game.visitor_team,
        bestPicks: topBets.map((b) => ({
          playerId: b.playerId,
          playerName: b.playerName,
          stat: b.stat,
          side: b.side,
          line: b.line,
          probability: Number((b.probability * 100).toFixed(1)), // %
          fairOdds: Number(b.fairOdds.toFixed(3)), // decimal odds
          seasonAvg: Number(b.seasonAvg.toFixed(2)),
          recentAvg: Number(b.recentAvg.toFixed(2)),
          sigma: Number(b.sigma.toFixed(2)),
        })),
      });
    }

    res.json({
      season: CURRENT_SEASON,
      minProb,
      maxProb,
      perGame,
      games: result,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error", details: err.message });
  }
});

// ================ EPL FOOTBALL SECTION ================

// EPL stat keys for team/match stats
const EPL_MATCH_STATS = [
  "goals",
  "assists",
  "yellow_cards",
  "red_cards",
  "offsides",
  "corners",
  "passes",
  "touches",
  "shots_on_target",
  "tackles",
];

// EPL player stat keys
const EPL_PLAYER_STATS = [
  "goals",
  "assists",
  "shots_on_target",
  "yellow_cards",
  "tackles",
  "passes",
];

// Stat extractors for EPL team stats
// Helper function to convert API stats array to object
function convertStatsArrayToObject(statsArray) {
  const statsObj = {};
  if (!statsArray || !Array.isArray(statsArray)) return statsObj;

  statsArray.forEach(stat => {
    if (stat && stat.name && stat.value !== undefined) {
      statsObj[stat.name] = stat.value;
    }
  });

  return statsObj;
}

const eplTeamStatExtractors = {
  goals: (s) => s.goals || 0,
  assists: (s) => s.goal_assist || 0,
  yellow_cards: (s) => s.total_yel_card || 0,
  red_cards: (s) => s.red_card || 0,
  offsides: (s) => s.total_offside || 0,
  corners: (s) => s.att_corner || 0,
  passes: (s) => s.total_pass || 0,
  touches: (s) => s.touches || 0,
  shots_on_target: (s) => s.ontarget_scoring_att || 0,
  tackles: (s) => s.total_tackle || 0,
  clearances: (s) => s.total_clearance || 0,
  fouls: (s) => s.fk_foul_lost || 0,
};

// Stat extractors for EPL player stats
const eplPlayerStatExtractors = {
  goals: (s) => s.goals || 0,
  assists: (s) => s.assists || 0,
  shots_on_target: (s) => s.shots_on_target || 0,
  yellow_cards: (s) => s.yellow_cards || 0,
  tackles: (s) => s.tackles || 0,
  passes: (s) => s.passes || 0,
  fouls: (s) => s.fouls || 0,
};

// Cache for EPL teams
let eplTeamsCache = null;

// Get all EPL teams
async function fetchAllEPLTeams() {
  if (eplTeamsCache) return eplTeamsCache;

  const url = new URL(`${API_BASE}/epl/v1/teams`);
  url.searchParams.append("season", CURRENT_EPL_SEASON);
  url.searchParams.append("per_page", 100);

  const json = await bdFetch(url.toString());

  // Create ID to team mapping
  const teamsMap = {};
  (json.data || []).forEach(team => {
    teamsMap[team.id] = team;
  });

  eplTeamsCache = teamsMap;
  return teamsMap;
}

// Get EPL games by week number
async function fetchEPLGamesByWeek(week) {
  const url = new URL(`${API_BASE}/epl/v1/games`);
  url.searchParams.append("season", CURRENT_EPL_SEASON);
  url.searchParams.append("week", week);
  url.searchParams.append("per_page", 100);

  const json = await bdFetch(url.toString());

  // Fetch teams mapping
  const teamsMap = await fetchAllEPLTeams();

  // Add team objects with names
  const gamesWithTeams = (json.data || []).map((game) => ({
    ...game,
    home_team: teamsMap[game.home_team_id] || { id: game.home_team_id, name: `Team ${game.home_team_id}` },
    away_team: teamsMap[game.away_team_id] || { id: game.away_team_id, name: `Team ${game.away_team_id}` },
  }));

  return gamesWithTeams;
}

// Get EPL games (upcoming - by date)
async function fetchEPLGames(limit = 10) {
  const nowCET = new Date().toLocaleString("en-US", {
    timeZone: "Europe/Paris",
  });
  const cetDate = new Date(nowCET);

  const yesterday = new Date(cetDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const startDate = yesterday.toISOString().slice(0, 10);

  const url = new URL(`${API_BASE}/epl/v1/games`);
  url.searchParams.append("start_date", startDate);
  url.searchParams.append("season", CURRENT_EPL_SEASON);
  url.searchParams.append("per_page", limit * 2);

  const json = await bdFetch(url.toString());

  const now = Date.now();
  const upcomingGames = (json.data || []).filter((game) => {
    const gameTime = new Date(game.kickoff).getTime();
    return gameTime > now;
  });

  return upcomingGames.slice(0, limit);
}

// Get EPL team by ID
async function fetchEPLTeam(teamId) {
  const url = `${API_BASE}/epl/v1/teams/${teamId}`;
  const json = await bdFetch(url);
  return json.data;
}

// Detect next upcoming gameweek automatically using incremental week search
async function detectNextGameweek() {
  console.log(`[EPL] 🔍 Auto-detecting gameweek (incremental search)...`);

  // Search weeks 1-38 to find first week with upcoming games
  for (let week = 1; week <= 38; week++) {
    try {
      console.log(`[EPL]    🔎 Checking week ${week}...`);

      const games = await fetchEPLGamesByWeek(week);

      if (games.length === 0) {
        console.log(`[EPL]       ❌ Week ${week}: No games found`);
        continue;
      }

      // Count game statuses
      const statusCounts = {};
      games.forEach(g => {
        statusCounts[g.status] = (statusCounts[g.status] || 0) + 1;
      });

      // Filter for upcoming games
      const upcomingGames = games.filter(g =>
        g.status === "PreMatch" ||
        g.status === "NS" ||
        g.status === "Scheduled" ||
        g.status === "NotStarted"
      );

      console.log(`[EPL]       📊 Week ${week}: ${games.length} games, statuses:`, statusCounts);

      if (upcomingGames.length > 0) {
        console.log(`[EPL]    ✅ Found next gameweek: ${week} (${upcomingGames.length} upcoming games)`);
        console.log(`[EPL]       Sample: ${upcomingGames[0].home_team.name} vs ${upcomingGames[0].away_team.name}`);
        return week;
      } else {
        console.log(`[EPL]       ⏭️  Week ${week}: All games completed, continuing...`);
      }

    } catch (err) {
      console.log(`[EPL]       ⚠️  Week ${week}: Error - ${err.message}`);
      continue;
    }
  }

  // If we get here, no upcoming games found in entire season
  console.log('[EPL]    ⚠️  No upcoming games found in any week (1-38), defaulting to week 12');
  return 12;
}

// Get EPL team season stats (aggregated)
async function fetchEPLTeamSeasonStats(teamId) {
  const url = new URL(`${API_BASE}/epl/v1/stats/teams/season`);
  url.searchParams.append("season", CURRENT_EPL_SEASON);
  url.searchParams.append("team_ids[]", teamId);

  const json = await bdFetch(url.toString());
  return json.data || [];
}

// Get EPL game stats (match-level team stats)
async function fetchEPLGameStats(gameId) {
  const url = `${API_BASE}/epl/v1/games/${gameId}/team_stats`;

  const json = await bdFetch(url);
  return json; // Return the whole response with json.data.teams structure
}

// Get recent EPL games for a team
async function fetchEPLTeamRecentGames(teamId, limit = 10) {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const url = new URL(`${API_BASE}/epl/v1/games`);
  url.searchParams.append("season", CURRENT_EPL_SEASON);
  url.searchParams.append("start_date", startDate);
  url.searchParams.append("end_date", endDate);
  url.searchParams.append("team_ids[]", teamId);
  url.searchParams.append("per_page", limit);

  const json = await bdFetch(url.toString());

  // Get teams mapping for names
  const teamsMap = await fetchAllEPLTeams();

  // Filter only completed games (EPL uses "FullTime" for completed matches)
  const completedGames = (json.data || []).filter(
    (game) => game.status === "FullTime" || game.status === "FT" || game.status === "C" || game.status === "complete" || game.status === "Final"
  );

  console.log(`[EPL] Found ${completedGames.length} completed games for team ${teamId}`);

  const gamesWithStats = [];

  // Fetch stats for each game
  for (const game of completedGames.slice(0, limit)) {
    try {
      const statsData = await fetchEPLGameStats(game.id);

      // statsData is the API response {data: {game_id, teams: [{team_id, stats: [...]}]}}
      const teams = statsData.data?.teams || statsData.teams || [];

      let homeStats = {};
      let awayStats = {};

      // Find home and away team stats
      for (const team of teams) {
        const statsObj = convertStatsArrayToObject(team.stats);

        // Log first game's stats for debugging - show ALL keys
        if (gamesWithStats.length === 0) {
          const allKeys = Object.keys(statsObj);
          console.log(`[EPL] ALL stats for game ${game.id} (${allKeys.length} keys):`, allKeys);
          // Log specific stats we care about
          console.log(`[EPL] Key stats:`, {
            corners: statsObj.att_corner || statsObj.corner_taken || statsObj.corners,
            shots: statsObj.ontarget_scoring_att || statsObj.total_scoring_att,
            cards: statsObj.total_yel_card || statsObj.yellow_card,
            fouls: statsObj.fk_foul_lost || statsObj.fouls,
          });
        }

        if (team.team_id === game.home_team_id) {
          homeStats = statsObj;
        } else if (team.team_id === game.away_team_id) {
          awayStats = statsObj;
        }
      }

      // Add team names from teamsMap
      gamesWithStats.push({
        ...game,
        home_team: teamsMap[game.home_team_id] || { id: game.home_team_id, name: `Team ${game.home_team_id}` },
        away_team: teamsMap[game.away_team_id] || { id: game.away_team_id, name: `Team ${game.away_team_id}` },
        home_team_stats: homeStats,
        away_team_stats: awayStats,
      });
    } catch (err) {
      console.error(`[EPL] Error fetching stats for game ${game.id}:`, err.message);
      // Skip games with errors
    }
  }

  return gamesWithStats;
}

// Get EPL players for a team
async function fetchEPLPlayersForTeam(teamId) {
  const players = [];
  let cursor = undefined;

  while (true) {
    const url = new URL(`${API_BASE}/epl/v1/players`);
    url.searchParams.append("season", CURRENT_EPL_SEASON);
    url.searchParams.append("team_ids[]", teamId);
    url.searchParams.append("per_page", 100);
    if (cursor !== undefined) {
      url.searchParams.append("cursor", cursor);
    }

    const json = await bdFetch(url.toString());
    if (json.data && json.data.length) {
      players.push(...json.data);
    }

    if (json.meta && json.meta.next_cursor) {
      cursor = json.meta.next_cursor;
    } else {
      break;
    }
  }

  return players;
}

// Get EPL player season stats
async function fetchEPLPlayerSeasonStats(playerId) {
  const url = new URL(`${API_BASE}/epl/v1/players/${playerId}/season_stats`);
  url.searchParams.append("season", CURRENT_EPL_SEASON);

  const json = await bdFetch(url.toString());
  return json.data || [];
}

// Get EPL player game stats
async function fetchEPLPlayerGameStats(playerId, gameIds = []) {
  const allStats = [];

  // Fetch player stats for each game individually
  for (const gameId of gameIds) {
    try {
      const url = `${API_BASE}/epl/v1/games/${gameId}/player_stats`;
      const json = await bdFetch(url);
      const gameStats = json.data || [];

      // Filter for the specific player
      const playerStats = gameStats.filter(stat => stat.player_id === playerId);
      allStats.push(...playerStats);
    } catch (err) {
      console.error(`[EPL] Error fetching player stats for game ${gameId}:`, err.message);
    }
  }

  return allStats;
}

// Build stat series for team stats
function buildEPLTeamStatSeries(gameStats, teamId, statKey) {
  const extractor = eplTeamStatExtractors[statKey];
  if (!extractor) return [];

  return gameStats
    .map((gs) => {
      // Find the right team's stats
      const teamStats =
        gs.home_team_id === teamId ? gs.home_stats : gs.away_stats;
      return teamStats ? extractor(teamStats) : null;
    })
    .filter((v) => v != null && Number.isFinite(v));
}

// Build stat series for player stats
function buildEPLPlayerStatSeries(playerGameStats, statKey) {
  const extractor = eplPlayerStatExtractors[statKey];
  if (!extractor) return [];

  return playerGameStats
    .map((pgs) => extractor(pgs))
    .filter((v) => v != null && Number.isFinite(v));
}

// Generate match stat predictions (team totals)
function generateMatchStatPredictions({
  homeTeamId,
  awayTeamId,
  homeRecentGames,
  awayRecentGames,
  minProb,
  maxProb,
}) {
  const predictions = [];

  // Fetch game stats for recent games
  const homeRecentStats = homeRecentGames.map((g) => ({
    game_id: g.id,
    home_team_id: g.home_team_id,
    away_team_id: g.away_team_id,
    home_stats: g.home_team_stats,
    away_stats: g.away_team_stats,
  }));

  const awayRecentStats = awayRecentGames.map((g) => ({
    game_id: g.id,
    home_team_id: g.home_team_id,
    away_team_id: g.away_team_id,
    home_stats: g.home_team_stats,
    away_stats: g.away_team_stats,
  }));

  // For each stat type
  for (const statKey of EPL_MATCH_STATS) {
    const homeSeasonValues = buildEPLTeamStatSeries(
      homeRecentStats,
      homeTeamId,
      statKey
    );
    const awaySeasonValues = buildEPLTeamStatSeries(
      awayRecentStats,
      awayTeamId,
      statKey
    );

    if (homeSeasonValues.length < 3 && awaySeasonValues.length < 3) {
      continue; // insufficient data
    }

    // Use all 10 games as "recent" for maximum recency weight
    const homeRecentValues = homeSeasonValues; // Use all fetched games
    const awayRecentValues = awaySeasonValues; // Use all fetched games

    // Calculate combined mean for line generation
    const homeMean = homeSeasonValues.length
      ? homeSeasonValues.reduce((a, b) => a + b, 0) / homeSeasonValues.length
      : 0;
    const awayMean = awaySeasonValues.length
      ? awaySeasonValues.reduce((a, b) => a + b, 0) / awaySeasonValues.length
      : 0;
    const combinedMean = homeMean + awayMean;

    // Scan lines
    const minLine = Math.max(0, Math.floor(combinedMean - 3));
    const maxLine = Math.ceil(combinedMean + 3);

    const candidates = [];

    for (let line = minLine; line <= maxLine; line += 0.5) {
      try {
        const overRes = computeMatchStatProb({
          homeSeasonValues,
          awaySeasonValues,
          homeRecentValues,
          awayRecentValues,
          line,
          side: "over",
        });

        if (overRes.p >= minProb && overRes.p <= maxProb) {
          candidates.push({
            statKey,
            line: Number(line.toFixed(1)),
            side: "over",
            probability: overRes.p,
            fairOdds: overRes.fairOdds,
            homeAvg: overRes.homeAvg,
            awayAvg: overRes.awayAvg,
            matchPrediction: overRes.matchPrediction,
          });
        }

        const underRes = computeMatchStatProb({
          homeSeasonValues,
          awaySeasonValues,
          homeRecentValues,
          awayRecentValues,
          line,
          side: "under",
        });

        if (underRes.p >= minProb && underRes.p <= maxProb) {
          candidates.push({
            statKey,
            line: Number(line.toFixed(1)),
            side: "under",
            probability: underRes.p,
            fairOdds: underRes.fairOdds,
            homeAvg: underRes.homeAvg,
            awayAvg: underRes.awayAvg,
            matchPrediction: underRes.matchPrediction,
          });
        }
      } catch (e) {
        // skip
      }
    }

    // Take best candidates
    candidates.sort((a, b) => b.probability - a.probability);
    predictions.push(...candidates.slice(0, 2));
  }

  return predictions;
}

// Generate player prop predictions
function generateEPLPlayerPropPredictions({
  player,
  seasonStats,
  recentGames,
  minProb,
  maxProb,
}) {
  const predictions = [];

  if (!seasonStats || seasonStats.length === 0) return predictions;

  // Get player game stats for recent games
  const recentGameIds = recentGames.map((g) => g.id);

  for (const statKey of EPL_PLAYER_STATS) {
    // Build season series
    const seasonValues = seasonStats.map((s) => {
      const extractor = eplPlayerStatExtractors[statKey];
      return extractor ? extractor(s) : 0;
    });

    if (seasonValues.length < 5) continue;

    // Recent values (last 5 games)
    const recentValues = seasonValues.slice(0, 5);

    const seasonMean =
      seasonValues.reduce((a, b) => a + b, 0) / seasonValues.length;

    // Scan lines
    const minLine = Math.max(0, Math.floor(seasonMean - 2));
    const maxLine = Math.ceil(seasonMean + 2);

    const candidates = [];

    for (let line = minLine; line <= maxLine; line += 0.5) {
      try {
        const overRes = computePlayerPropProb({
          seasonValues,
          recentValues,
          line,
          side: "over",
        });

        if (overRes.p >= minProb && overRes.p <= maxProb) {
          candidates.push({
            playerId: player.id,
            playerName: `${player.first_name} ${player.last_name}`,
            statKey,
            line: Number(line.toFixed(1)),
            side: "over",
            probability: overRes.p,
            fairOdds: overRes.fairOdds,
            seasonAvg: overRes.seasonAvg,
            recentAvg: overRes.recentAvg,
          });
        }

        const underRes = computePlayerPropProb({
          seasonValues,
          recentValues,
          line,
          side: "under",
        });

        if (underRes.p >= minProb && underRes.p <= maxProb) {
          candidates.push({
            playerId: player.id,
            playerName: `${player.first_name} ${player.last_name}`,
            statKey,
            line: Number(line.toFixed(1)),
            side: "under",
            probability: underRes.p,
            fairOdds: underRes.fairOdds,
            seasonAvg: underRes.seasonAvg,
            recentAvg: underRes.recentAvg,
          });
        }
      } catch (e) {
        // skip
      }
    }

    candidates.sort((a, b) => b.probability - a.probability);
    predictions.push(...candidates.slice(0, 1));
  }

  return predictions;
}

/**
 * Remove conflicting predictions (over/under for same stat)
 * Keep only the prediction with highest probability
 * @param {Array} predictions - Array of predictions
 * @returns {Array} Filtered predictions without conflicts
 */
function removeConflictingPredictions(predictions) {
  const groupedByKey = {};

  // Group predictions by unique key (statKey + playerName if exists)
  for (const pred of predictions) {
    // Create unique key for this prediction
    let key = pred.statKey;
    if (pred.type === 'player' && pred.playerName) {
      key = `${pred.playerName}_${pred.statKey}`;
    }

    if (!groupedByKey[key]) {
      groupedByKey[key] = [];
    }
    groupedByKey[key].push(pred);
  }

  const filteredPredictions = [];

  // For each group, check for conflicts and keep highest probability
  for (const key in groupedByKey) {
    const group = groupedByKey[key];

    if (group.length === 1) {
      // No conflict, keep it
      filteredPredictions.push(group[0]);
    } else {
      // Multiple predictions for same stat - check if they conflict
      const sides = new Set(group.map(p => p.side));

      if (sides.has('over') && sides.has('under')) {
        // Conflict detected! Keep only highest probability
        const best = group.reduce((max, p) =>
          p.probability > max.probability ? p : max
        );
        filteredPredictions.push(best);
        console.log(`[EPL]      ⚠️  Conflict removed: ${key} - kept ${best.side} (${(best.probability * 100).toFixed(1)}%)`);
      } else {
        // No conflict (multiple overs or multiple unders), keep all
        filteredPredictions.push(...group);
      }
    }
  }

  return filteredPredictions;
}

// ---------------- CACHE REFRESH FUNCTIONS ----------------

/**
 * Refresh EPL predictions cache
 */
async function refreshEPLCache() {
  if (cache.epl.isLoading) {
    console.log('[CACHE] EPL cache refresh already in progress, skipping...');
    return;
  }

  cache.epl.isLoading = true;
  console.log('[CACHE] Starting EPL cache refresh...');

  try {
    const minProb = 0.58;
    const maxProb = 0.62;

    // Auto-detect gameweek
    const week = await detectNextGameweek();
    console.log(`[CACHE] EPL: Fetching gameweek ${week}...`);

    const games = await fetchEPLGamesByWeek(week);
    console.log(`[CACHE] EPL: Found ${games.length} match(es)`);

    const result = [];
    let totalMatchPredictions = 0;
    let totalPlayerPredictions = 0;

    for (const game of games) {
      console.log(`[CACHE] EPL: Processing ${game.home_team.name} vs ${game.away_team.name}`);

      const homeTeamId = game.home_team.id;
      const awayTeamId = game.away_team.id;

      const [homeRecentGames, awayRecentGames] = await Promise.all([
        fetchEPLTeamRecentGames(homeTeamId, 10),
        fetchEPLTeamRecentGames(awayTeamId, 10),
      ]);

      // Generate match stat predictions
      const matchPredictions = generateMatchStatPredictions({
        homeTeamId,
        awayTeamId,
        homeRecentGames,
        awayRecentGames,
        minProb,
        maxProb,
      });

      // Get players for both teams
      const [homePlayers, awayPlayers] = await Promise.all([
        fetchEPLPlayersForTeam(homeTeamId),
        fetchEPLPlayersForTeam(awayTeamId),
      ]);

      const topHomePlayers = homePlayers.slice(0, 6);
      const topAwayPlayers = awayPlayers.slice(0, 6);
      const allPlayers = [...topHomePlayers, ...topAwayPlayers];

      const playerPredictions = [];

      for (const player of allPlayers) {
        try {
          const seasonStats = await fetchEPLPlayerSeasonStats(player.id);
          if (seasonStats.length < 5) continue;

          const recentGames = homeRecentGames.concat(awayRecentGames);

          const playerProps = generateEPLPlayerPropPredictions({
            player,
            seasonStats,
            recentGames,
            minProb,
            maxProb,
          });

          playerPredictions.push(...playerProps);
        } catch (e) {
          // skip player errors
        }
      }

      // Combine all predictions
      let allPredictions = [
        ...matchPredictions.map((p) => ({ ...p, type: "match" })),
        ...playerPredictions.map((p) => ({ ...p, type: "player" })),
      ];

      // Filter low confidence and remove conflicts
      allPredictions = allPredictions.filter((p) => p.probability >= 0.59);
      allPredictions = removeConflictingPredictions(allPredictions);
      allPredictions.sort((a, b) => b.probability - a.probability);

      totalMatchPredictions += matchPredictions.length;
      totalPlayerPredictions += playerPredictions.length;

      result.push({
        gameId: game.id,
        kickoff: game.kickoff,
        week: game.week,
        home_team: game.home_team,
        away_team: game.away_team,
        predictions: allPredictions.slice(0, 15).map((p) => ({
          ...p,
          probability: Number((p.probability * 100).toFixed(1)),
          fairOdds: Number(p.fairOdds.toFixed(3)),
        })),
      });
    }

    // Store in cache
    cache.epl.data = {
      season: CURRENT_EPL_SEASON,
      week: week,
      minProb,
      maxProb,
      matches: result,
    };
    cache.epl.lastUpdated = new Date().toISOString();
    cache.epl.isLoading = false;

    console.log(`[CACHE] EPL cache refreshed successfully!`);
    console.log(`[CACHE]    Matches: ${result.length}`);
    console.log(`[CACHE]    Total predictions: ${totalMatchPredictions + totalPlayerPredictions}`);
    console.log(`[CACHE]    Last updated: ${cache.epl.lastUpdated}`);

  } catch (err) {
    console.error('[CACHE] EPL cache refresh failed:', err.message);
    cache.epl.isLoading = false;
  }
}

/**
 * Refresh NBA predictions cache
 */
async function refreshNBACache() {
  if (cache.nba.isLoading) {
    console.log('[CACHE] NBA cache refresh already in progress, skipping...');
    return;
  }

  cache.nba.isLoading = true;
  console.log('[CACHE] Starting NBA cache refresh...');

  try {
    const minProb = 0.58;
    const maxProb = 0.62;
    const gamesLimit = 10;

    // Get today's games
    const today = new Date().toISOString().split("T")[0];
    const gamesUrl = `${BASE_URL}/games?dates[]=${today}&per_page=${gamesLimit}`;

    const gamesRes = await fetch(gamesUrl, {
      headers: { Authorization: API_KEY },
    });

    if (!gamesRes.ok) {
      throw new Error(`Games fetch failed: ${gamesRes.status}`);
    }

    const gamesData = await gamesRes.json();
    const games = gamesData.data || [];

    console.log(`[CACHE] NBA: Found ${games.length} games for ${today}`);

    const result = [];

    for (const game of games) {
      console.log(`[CACHE] NBA: Processing ${game.home_team.full_name} vs ${game.visitor_team.full_name}`);

      // Get players for both teams
      const homePlayersUrl = `${BASE_URL}/players?team_ids[]=${game.home_team.id}&per_page=15`;
      const awayPlayersUrl = `${BASE_URL}/players?team_ids[]=${game.visitor_team.id}&per_page=15`;

      const [homeRes, awayRes] = await Promise.all([
        fetch(homePlayersUrl, { headers: { Authorization: API_KEY } }),
        fetch(awayPlayersUrl, { headers: { Authorization: API_KEY } }),
      ]);

      const homePlayers = (await homeRes.json()).data || [];
      const awayPlayers = (await awayRes.json()).data || [];

      const predictions = [];

      // Process top players from each team
      const topPlayers = [...homePlayers.slice(0, 5), ...awayPlayers.slice(0, 5)];

      for (const player of topPlayers) {
        try {
          // Get player season averages
          const avgUrl = `${BASE_URL}/season_averages?season=${CURRENT_SEASON}&player_ids[]=${player.id}`;
          const avgRes = await fetch(avgUrl, { headers: { Authorization: API_KEY } });
          const avgData = await avgRes.json();
          const seasonAvg = avgData.data?.[0];

          if (!seasonAvg || seasonAvg.games_played < 5) continue;

          // Get recent game logs
          const logsUrl = `${BASE_URL}/stats?seasons[]=${CURRENT_SEASON}&player_ids[]=${player.id}&per_page=10`;
          const logsRes = await fetch(logsUrl, { headers: { Authorization: API_KEY } });
          const logsData = await logsRes.json();
          const recentGames = logsData.data || [];

          if (recentGames.length < 3) continue;

          // Generate predictions for common props
          const props = ['pts', 'reb', 'ast'];

          for (const prop of props) {
            const values = recentGames.map(g => g[prop]).filter(v => v != null);
            if (values.length < 3) continue;

            const result = computePropProb(values, seasonAvg[prop] || 0, prop);

            if (result && result.probability >= minProb && result.probability <= maxProb) {
              predictions.push({
                playerId: player.id,
                playerName: `${player.first_name} ${player.last_name}`,
                team: game.home_team.id === player.team_id ? game.home_team.abbreviation : game.visitor_team.abbreviation,
                prop,
                line: result.line,
                side: result.side,
                probability: Number((result.probability * 100).toFixed(1)),
                fairOdds: Number((1 / result.probability).toFixed(3)),
              });
            }
          }
        } catch (e) {
          // skip player errors
        }
      }

      // Filter low confidence and remove conflicts
      let filteredPredictions = predictions.filter(p => p.probability >= 59);
      filteredPredictions.sort((a, b) => b.probability - a.probability);

      result.push({
        gameId: game.id,
        date: game.date,
        time: game.time,
        status: game.status,
        home_team: game.home_team,
        visitor_team: game.visitor_team,
        predictions: filteredPredictions.slice(0, 15),
      });
    }

    // Store in cache
    cache.nba.data = {
      season: CURRENT_SEASON,
      date: today,
      minProb,
      maxProb,
      games: result,
    };
    cache.nba.lastUpdated = new Date().toISOString();
    cache.nba.isLoading = false;

    console.log(`[CACHE] NBA cache refreshed successfully!`);
    console.log(`[CACHE]    Games: ${result.length}`);
    console.log(`[CACHE]    Last updated: ${cache.nba.lastUpdated}`);

  } catch (err) {
    console.error('[CACHE] NBA cache refresh failed:', err.message);
    cache.nba.isLoading = false;
  }
}

// ---------------- EPL ENDPOINTS ----------------

// GET /api/epl/todays-matches - Get today's EPL matches with predictions (from cache)
app.get("/api/epl/todays-matches", async (req, res) => {
  try {
    // Check if cache is available
    if (cache.epl.data) {
      console.log(`[EPL] Serving from cache (last updated: ${cache.epl.lastUpdated})`);
      return res.json({
        ...cache.epl.data,
        lastUpdated: cache.epl.lastUpdated,
        fromCache: true,
      });
    }

    // If cache is loading, return loading status
    if (cache.epl.isLoading) {
      console.log('[EPL] Cache is loading, returning loading status...');
      return res.status(202).json({
        message: 'Data is being loaded, please retry in a few seconds',
        isLoading: true,
      });
    }

    // Cache is empty and not loading - trigger refresh and return loading status
    console.log('[EPL] Cache empty, triggering refresh...');
    refreshEPLCache();
    return res.status(202).json({
      message: 'Data is being loaded, please retry in a few seconds',
      isLoading: true,
    });
  } catch (err) {
    console.error("[EPL] Error:", err);
    res.status(500).json({ error: "Internal error", details: err.message });
  }
});

// GET /api/epl/cache-status - Check EPL cache status
app.get("/api/epl/cache-status", (req, res) => {
  res.json({
    hasData: !!cache.epl.data,
    isLoading: cache.epl.isLoading,
    lastUpdated: cache.epl.lastUpdated,
    matchCount: cache.epl.data?.matches?.length || 0,
  });
});

// POST /api/epl/refresh-cache - Manually trigger cache refresh
app.post("/api/epl/refresh-cache", async (req, res) => {
  if (cache.epl.isLoading) {
    return res.status(202).json({ message: 'Cache refresh already in progress' });
  }
  refreshEPLCache();
  res.json({ message: 'Cache refresh started' });
});

// GET /api/epl/match/:gameId/analysis - Get detailed match analysis with team stats
app.get("/api/epl/match/:gameId/analysis", async (req, res) => {
  try {
    const gameId = parseInt(req.params.gameId);
    console.log(`[EPL Analysis] Fetching analysis for game ${gameId}`);

    // First, find the game in the cache or fetch it
    let game = null;
    if (cache.epl.data?.matches) {
      game = cache.epl.data.matches.find(m => m.gameId === gameId);
    }

    if (!game) {
      // Try to fetch the game by searching recent games
      try {
        const url = new URL(`${API_BASE}/epl/v1/games`);
        url.searchParams.append("season", CURRENT_EPL_SEASON);
        url.searchParams.append("per_page", 100);
        const json = await bdFetch(url.toString());

        const foundGame = (json.data || []).find(g => g.id === gameId);
        if (foundGame) {
          const teamsMap = await fetchAllEPLTeams();
          game = {
            gameId: foundGame.id,
            kickoff: foundGame.kickoff,
            status: foundGame.status,
            home_team: teamsMap[foundGame.home_team_id] || { id: foundGame.home_team_id, name: `Team ${foundGame.home_team_id}` },
            away_team: teamsMap[foundGame.away_team_id] || { id: foundGame.away_team_id, name: `Team ${foundGame.away_team_id}` },
            home_team_id: foundGame.home_team_id,
            away_team_id: foundGame.away_team_id,
          };
        }
      } catch (err) {
        console.error(`[EPL Analysis] Could not fetch game ${gameId}:`, err.message);
      }
    }

    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    // Fetch recent games for both teams
    console.log(`[EPL Analysis] Fetching recent games for ${game.home_team.name} and ${game.away_team.name}`);

    const [homeRecentGames, awayRecentGames] = await Promise.all([
      fetchEPLTeamRecentGames(game.home_team_id || game.home_team.id, 10),
      fetchEPLTeamRecentGames(game.away_team_id || game.away_team.id, 10),
    ]);

    // Format the response with detailed stats
    const formatGameStats = (games, teamId, teamName) => {
      return games.map(g => {
        const isHome = g.home_team_id === teamId;
        const teamStats = isHome ? g.home_team_stats : g.away_team_stats;
        const opponentStats = isHome ? g.away_team_stats : g.home_team_stats;

        return {
          gameId: g.id,
          date: g.kickoff,
          opponent: isHome ? g.away_team?.name || `Team ${g.away_team_id}` : g.home_team?.name || `Team ${g.home_team_id}`,
          isHome,
          score: g.score || null,
          stats: {
            corners: teamStats?.att_corner || teamStats?.corners || 0,
            yellowCards: teamStats?.total_yel_card || teamStats?.yellow_cards || 0,
            redCards: teamStats?.red_card || teamStats?.red_cards || 0,
            shotsOnTarget: teamStats?.ontarget_scoring_att || teamStats?.shots_on_goal || 0,
            shotsTotal: (teamStats?.ontarget_scoring_att || 0) + (teamStats?.shot_off_target || 0),
            offsides: teamStats?.total_offside || teamStats?.offsides || 0,
            fouls: teamStats?.fouls || teamStats?.fk_foul_lost || 0,
            possession: teamStats?.possession_percentage || teamStats?.possession || 0,
          },
          opponentStats: {
            corners: opponentStats?.att_corner || opponentStats?.corners || 0,
            yellowCards: opponentStats?.total_yel_card || opponentStats?.yellow_cards || 0,
            redCards: opponentStats?.red_card || opponentStats?.red_cards || 0,
            shotsOnTarget: opponentStats?.ontarget_scoring_att || opponentStats?.shots_on_goal || 0,
            shotsTotal: (opponentStats?.ontarget_scoring_att || 0) + (opponentStats?.shot_off_target || 0),
            offsides: opponentStats?.total_offside || opponentStats?.offsides || 0,
            fouls: opponentStats?.fouls || opponentStats?.fk_foul_lost || 0,
            possession: opponentStats?.possession_percentage || opponentStats?.possession || 0,
          },
        };
      });
    };

    // Calculate averages
    const calculateAverages = (formattedGames) => {
      if (formattedGames.length === 0) return null;

      const sum = formattedGames.reduce((acc, g) => ({
        corners: acc.corners + g.stats.corners,
        yellowCards: acc.yellowCards + g.stats.yellowCards,
        redCards: acc.redCards + g.stats.redCards,
        shotsOnTarget: acc.shotsOnTarget + g.stats.shotsOnTarget,
        shotsTotal: acc.shotsTotal + g.stats.shotsTotal,
        offsides: acc.offsides + g.stats.offsides,
        fouls: acc.fouls + g.stats.fouls,
      }), { corners: 0, yellowCards: 0, redCards: 0, shotsOnTarget: 0, shotsTotal: 0, offsides: 0, fouls: 0 });

      const count = formattedGames.length;
      return {
        corners: (sum.corners / count).toFixed(1),
        yellowCards: (sum.yellowCards / count).toFixed(1),
        redCards: (sum.redCards / count).toFixed(1),
        shotsOnTarget: (sum.shotsOnTarget / count).toFixed(1),
        shotsTotal: (sum.shotsTotal / count).toFixed(1),
        offsides: (sum.offsides / count).toFixed(1),
        fouls: (sum.fouls / count).toFixed(1),
      };
    };

    const homeFormatted = formatGameStats(homeRecentGames, game.home_team_id || game.home_team.id, game.home_team.name);
    const awayFormatted = formatGameStats(awayRecentGames, game.away_team_id || game.away_team.id, game.away_team.name);

    const response = {
      game: {
        id: game.gameId,
        kickoff: game.kickoff,
        status: game.status,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
      },
      homeTeam: {
        name: game.home_team.name,
        recentGames: homeFormatted,
        averages: calculateAverages(homeFormatted),
        gamesAnalyzed: homeFormatted.length,
      },
      awayTeam: {
        name: game.away_team.name,
        recentGames: awayFormatted,
        averages: calculateAverages(awayFormatted),
        gamesAnalyzed: awayFormatted.length,
      },
    };

    console.log(`[EPL Analysis] Returning analysis with ${homeFormatted.length} home games and ${awayFormatted.length} away games`);
    res.json(response);

  } catch (err) {
    console.error("[EPL Analysis] Error:", err);
    res.status(500).json({ error: "Internal error", details: err.message });
  }
});

// ---------------- NBA ENDPOINTS ----------------

// GET /api/nba/todays-props - Get today's NBA props (from cache)
app.get("/api/nba/todays-props", async (req, res) => {
  try {
    // Check if cache is available
    if (cache.nba.data) {
      console.log(`[NBA] Serving from cache (last updated: ${cache.nba.lastUpdated})`);
      return res.json({
        ...cache.nba.data,
        lastUpdated: cache.nba.lastUpdated,
        fromCache: true,
      });
    }

    // If cache is loading, return loading status
    if (cache.nba.isLoading) {
      console.log('[NBA] Cache is loading, returning loading status...');
      return res.status(202).json({
        message: 'Data is being loaded, please retry in a few seconds',
        isLoading: true,
      });
    }

    // Cache is empty and not loading - trigger refresh and return loading status
    console.log('[NBA] Cache empty, triggering refresh...');
    refreshNBACache();
    return res.status(202).json({
      message: 'Data is being loaded, please retry in a few seconds',
      isLoading: true,
    });
  } catch (err) {
    console.error("[NBA] Error:", err);
    res.status(500).json({ error: "Internal error", details: err.message });
  }
});

// GET /api/nba/cache-status - Check NBA cache status
app.get("/api/nba/cache-status", (req, res) => {
  res.json({
    hasData: !!cache.nba.data,
    isLoading: cache.nba.isLoading,
    lastUpdated: cache.nba.lastUpdated,
    gameCount: cache.nba.data?.games?.length || 0,
  });
});

// POST /api/nba/refresh-cache - Manually trigger cache refresh
app.post("/api/nba/refresh-cache", async (req, res) => {
  if (cache.nba.isLoading) {
    return res.status(202).json({ message: 'Cache refresh already in progress' });
  }
  refreshNBACache();
  res.json({ message: 'Cache refresh started' });
});

// ---------------- START SERVER ----------------

app.listen(PORT, () => {
  console.log(
    `Server running on http://localhost:${PORT}`
  );
  console.log(`NBA Season: ${CURRENT_SEASON}, EPL Season: ${CURRENT_EPL_SEASON}`);

  // Schedule cron jobs to refresh cache every 2 hours
  // Cron format: minute hour day month weekday
  // '0 */2 * * *' = every 2 hours at minute 0

  cron.schedule('0 */2 * * *', () => {
    console.log('[CRON] Running scheduled EPL cache refresh...');
    refreshEPLCache();
  });

  cron.schedule('30 */2 * * *', () => {
    console.log('[CRON] Running scheduled NBA cache refresh...');
    refreshNBACache();
  });

  console.log('[CRON] Scheduled cache refresh jobs (every 2 hours)');

  // Initial cache population on server startup
  console.log('[CACHE] Starting initial cache population...');

  // Stagger the initial loads to avoid API rate limits
  setTimeout(() => {
    console.log('[CACHE] Populating EPL cache...');
    refreshEPLCache();
  }, 5000); // 5 second delay

  setTimeout(() => {
    console.log('[CACHE] Populating NBA cache...');
    refreshNBACache();
  }, 10000); // 10 second delay
});
