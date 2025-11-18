// server.js
require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const { computePropProb } = require("./evCalculator");

const app = express();
app.use(express.json());

const API_KEY = process.env.BALLDONTLIE_API_KEY;
const BASE_URL =
  process.env.BALLDONTLIE_BASE_URL || "https://api.balldontlie.io/v1";
const CURRENT_SEASON = Number(process.env.NBA_SEASON || 2025);
const PORT = process.env.PORT || 4000;

if (!API_KEY) {
  console.warn("WARNING: BALLDONTLIE_API_KEY is not set in .env");
}

// ---------------- CORS LOCKDOWN ----------------

const ALLOWED_ORIGIN = "https://betapi-frontend.vercel.app";

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Allow non-browser tools (curl, Insomnia, server-to-server)
  if (!origin) {
    return next();
  }

  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    return next();
  }

  // Any other browser origin is blocked
  return res.status(403).json({
    error: "Origin not allowed",
    details: `Origin ${origin} is not allowed to access this resource`,
  });
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

// ---------------- START SERVER ----------------

app.listen(PORT, () => {
  console.log(
    `Server running on http://localhost:${PORT} (season ${CURRENT_SEASON})`
  );
});
