// footballDataService.js - Football-Data.org API Service
// Fetches match and team stats for multiple European leagues

const fetch = require('node-fetch');

class FootballDataService {
  constructor() {
    this.apiKey = process.env.FOOTBALL_DATA_API_KEY;
    this.baseUrl = 'https://api.football-data.org/v4';

    // Available leagues (competition codes)
    this.leagues = {
      PL: { name: 'Premier League', country: 'England', oddsSlug: 'england-premier-league' },
      BL1: { name: 'Bundesliga', country: 'Germany', oddsSlug: 'germany-bundesliga' },
      SA: { name: 'Serie A', country: 'Italy', oddsSlug: 'italy-serie-a' },
      PD: { name: 'La Liga', country: 'Spain', oddsSlug: 'spain-la-liga' },
      FL1: { name: 'Ligue 1', country: 'France', oddsSlug: 'france-ligue-1' },
      CL: { name: 'Champions League', country: 'Europe', oddsSlug: 'uefa-champions-league' },
      EL: { name: 'Europa League', country: 'Europe', oddsSlug: 'uefa-europa-league' },
      EC: { name: 'Conference League', country: 'Europe', oddsSlug: 'uefa-conference-league' }
    };

    // Cache for API responses (10 minute TTL)
    this.cache = new Map();
    this.cacheTTL = 10 * 60 * 1000;
  }

  /**
   * Make authenticated API request to football-data.org
   */
  async apiRequest(endpoint) {
    if (!this.apiKey) {
      throw new Error('FOOTBALL_DATA_API_KEY not configured in .env');
    }

    const cacheKey = endpoint;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }

    const url = `${this.baseUrl}${endpoint}`;
    console.log(`[Football-Data] Fetching: ${url}`);

    const response = await fetch(url, {
      headers: {
        'X-Auth-Token': this.apiKey
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Football-Data API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    this.cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  }

  /**
   * Test API connection and log status
   */
  async testConnection() {
    try {
      console.log('[Football-Data] Testing API connection...');
      const data = await this.apiRequest('/competitions');
      const competitions = data.competitions || [];
      console.log('═══════════════════════════════════════════════════════════');
      console.log('✅ FOOTBALL-DATA.ORG API CONNECTED SUCCESSFULLY');
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`   Available competitions: ${competitions.length}`);
      console.log(`   Supported leagues: ${Object.keys(this.leagues).join(', ')}`);
      console.log('═══════════════════════════════════════════════════════════');
      return true;
    } catch (error) {
      console.error('═══════════════════════════════════════════════════════════');
      console.error('❌ FOOTBALL-DATA.ORG API CONNECTION FAILED');
      console.error('═══════════════════════════════════════════════════════════');
      console.error(`   Error: ${error.message}`);
      console.error('   Check your FOOTBALL_DATA_API_KEY in environment variables');
      console.error('═══════════════════════════════════════════════════════════');
      return false;
    }
  }

  /**
   * Get list of available competitions
   */
  async getCompetitions() {
    try {
      const data = await this.apiRequest('/competitions');
      return data.competitions || [];
    } catch (error) {
      console.error('[Football-Data] Error fetching competitions:', error.message);
      return [];
    }
  }

  /**
   * Get competition details
   */
  async getCompetition(code) {
    try {
      const data = await this.apiRequest(`/competitions/${code}`);
      return data;
    } catch (error) {
      console.error(`[Football-Data] Error fetching competition ${code}:`, error.message);
      return null;
    }
  }

  /**
   * Get standings for a competition
   */
  async getStandings(competitionCode) {
    try {
      const data = await this.apiRequest(`/competitions/${competitionCode}/standings`);
      return data.standings || [];
    } catch (error) {
      console.error(`[Football-Data] Error fetching standings for ${competitionCode}:`, error.message);
      return [];
    }
  }

  /**
   * Get upcoming matches for a competition
   */
  async getUpcomingMatches(competitionCode, limit = 20) {
    try {
      // Get matches from today to 14 days ahead
      const today = new Date().toISOString().slice(0, 10);
      const endDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const data = await this.apiRequest(
        `/competitions/${competitionCode}/matches?dateFrom=${today}&dateTo=${endDate}&status=SCHEDULED,TIMED`
      );

      const matches = data.matches || [];
      console.log(`[Football-Data] Found ${matches.length} upcoming matches for ${competitionCode}`);

      return matches.slice(0, limit);
    } catch (error) {
      console.error(`[Football-Data] Error fetching matches for ${competitionCode}:`, error.message);
      return [];
    }
  }

  /**
   * Get matches for today/tomorrow
   */
  async getTodaysMatches(competitionCode) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const data = await this.apiRequest(
        `/competitions/${competitionCode}/matches?dateFrom=${today}&dateTo=${tomorrow}`
      );

      // Filter for scheduled matches only
      const scheduled = (data.matches || []).filter(
        m => m.status === 'SCHEDULED' || m.status === 'TIMED'
      );

      console.log(`[Football-Data] Found ${scheduled.length} matches today/tomorrow for ${competitionCode}`);
      return scheduled;
    } catch (error) {
      console.error(`[Football-Data] Error fetching today's matches for ${competitionCode}:`, error.message);
      return [];
    }
  }

  /**
   * Get matches across all supported leagues for today/tomorrow
   */
  async getAllTodaysMatches() {
    const allMatches = [];

    for (const [code, league] of Object.entries(this.leagues)) {
      try {
        const matches = await this.getTodaysMatches(code);
        for (const match of matches) {
          allMatches.push({
            ...match,
            leagueCode: code,
            leagueName: league.name,
            country: league.country,
            oddsSlug: league.oddsSlug
          });
        }
      } catch (error) {
        console.log(`[Football-Data] Skipping ${code}: ${error.message}`);
      }
    }

    // Sort by kickoff time
    allMatches.sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

    console.log(`[Football-Data] Total matches across all leagues: ${allMatches.length}`);
    return allMatches;
  }

  /**
   * Get team details
   */
  async getTeam(teamId) {
    try {
      const data = await this.apiRequest(`/teams/${teamId}`);
      return data;
    } catch (error) {
      console.error(`[Football-Data] Error fetching team ${teamId}:`, error.message);
      return null;
    }
  }

  /**
   * Get team's recent matches (last N completed matches)
   */
  async getTeamRecentMatches(teamId, limit = 10) {
    try {
      // Get matches from last 90 days
      const endDate = new Date().toISOString().slice(0, 10);
      const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const data = await this.apiRequest(
        `/teams/${teamId}/matches?dateFrom=${startDate}&dateTo=${endDate}&status=FINISHED`
      );

      const matches = (data.matches || [])
        .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
        .slice(0, limit);

      console.log(`[Football-Data] Found ${matches.length} recent matches for team ${teamId}`);
      return matches;
    } catch (error) {
      console.error(`[Football-Data] Error fetching team matches for ${teamId}:`, error.message);
      return [];
    }
  }

  /**
   * Get head-to-head between two teams
   */
  async getHeadToHead(matchId) {
    try {
      const data = await this.apiRequest(`/matches/${matchId}/head2head`);
      return data;
    } catch (error) {
      console.error(`[Football-Data] Error fetching H2H for match ${matchId}:`, error.message);
      return null;
    }
  }

  /**
   * Calculate team stats from recent matches
   */
  calculateTeamStats(matches, teamId) {
    if (!matches || matches.length === 0) {
      return null;
    }

    const stats = {
      gamesPlayed: matches.length,
      goalsFor: 0,
      goalsAgainst: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      cleanSheets: 0,
      corners: [],
      yellowCards: [],
      redCards: [],
      shots: [],
      fouls: []
    };

    for (const match of matches) {
      const isHome = match.homeTeam.id === teamId;
      const score = match.score?.fullTime;

      if (score) {
        const goalsScored = isHome ? score.home : score.away;
        const goalsConceded = isHome ? score.away : score.home;

        stats.goalsFor += goalsScored || 0;
        stats.goalsAgainst += goalsConceded || 0;

        if (goalsConceded === 0) stats.cleanSheets++;

        if (goalsScored > goalsConceded) stats.wins++;
        else if (goalsScored === goalsConceded) stats.draws++;
        else stats.losses++;
      }

      // Note: Detailed match stats like corners, cards require fetching each match individually
      // football-data.org provides goals in the basic match response
    }

    // Calculate averages
    const n = stats.gamesPlayed;
    stats.avgGoalsFor = (stats.goalsFor / n).toFixed(2);
    stats.avgGoalsAgainst = (stats.goalsAgainst / n).toFixed(2);
    stats.avgTotalGoals = ((stats.goalsFor + stats.goalsAgainst) / n).toFixed(2);
    stats.winRate = ((stats.wins / n) * 100).toFixed(1);

    return stats;
  }

  /**
   * Get match predictions based on team form
   */
  async generateMatchPredictions(match, minProb = 0.58, maxProb = 0.62) {
    const predictions = [];

    try {
      // Get recent matches for both teams
      const [homeMatches, awayMatches] = await Promise.all([
        this.getTeamRecentMatches(match.homeTeam.id, 10),
        this.getTeamRecentMatches(match.awayTeam.id, 10)
      ]);

      const homeStats = this.calculateTeamStats(homeMatches, match.homeTeam.id);
      const awayStats = this.calculateTeamStats(awayMatches, match.awayTeam.id);

      if (!homeStats || !awayStats) {
        console.log(`[Football-Data] Insufficient stats for ${match.homeTeam.name} vs ${match.awayTeam.name}`);
        return predictions;
      }

      // Calculate expected goals
      const expectedHomeGoals = (parseFloat(homeStats.avgGoalsFor) + parseFloat(awayStats.avgGoalsAgainst)) / 2;
      const expectedAwayGoals = (parseFloat(awayStats.avgGoalsFor) + parseFloat(homeStats.avgGoalsAgainst)) / 2;
      const expectedTotalGoals = expectedHomeGoals + expectedAwayGoals;

      console.log(`[Football-Data] ${match.homeTeam.name} vs ${match.awayTeam.name}: Expected total ${expectedTotalGoals.toFixed(2)}`);

      // Generate over/under predictions for total goals
      const totalGoalsLines = [1.5, 2.5, 3.5, 4.5];

      for (const line of totalGoalsLines) {
        // Calculate probability using Poisson-like approximation
        const prob = this.calculateTotalGoalsProbability(expectedTotalGoals, line);

        // Over probability
        if (prob.over >= minProb && prob.over <= maxProb) {
          predictions.push({
            type: 'match',
            statKey: 'goals',
            line,
            side: 'over',
            probability: prob.over,
            fairOdds: 1 / prob.over,
            homeAvg: parseFloat(homeStats.avgGoalsFor),
            awayAvg: parseFloat(awayStats.avgGoalsFor),
            matchPrediction: expectedTotalGoals
          });
        }

        // Under probability
        if (prob.under >= minProb && prob.under <= maxProb) {
          predictions.push({
            type: 'match',
            statKey: 'goals',
            line,
            side: 'under',
            probability: prob.under,
            fairOdds: 1 / prob.under,
            homeAvg: parseFloat(homeStats.avgGoalsFor),
            awayAvg: parseFloat(awayStats.avgGoalsFor),
            matchPrediction: expectedTotalGoals
          });
        }
      }

      // BTTS (Both Teams To Score) prediction
      const homeScoreProb = 1 - Math.exp(-expectedHomeGoals); // Poisson P(X >= 1)
      const awayScoreProb = 1 - Math.exp(-expectedAwayGoals);
      const bttsProb = homeScoreProb * awayScoreProb;

      if (bttsProb >= minProb && bttsProb <= maxProb) {
        predictions.push({
          type: 'match',
          statKey: 'btts',
          line: null,
          side: 'yes',
          probability: bttsProb,
          fairOdds: 1 / bttsProb,
          homeAvg: parseFloat(homeStats.avgGoalsFor),
          awayAvg: parseFloat(awayStats.avgGoalsFor),
          matchPrediction: null
        });
      }

      // Sort by probability
      predictions.sort((a, b) => b.probability - a.probability);

    } catch (error) {
      console.error(`[Football-Data] Error generating predictions:`, error.message);
    }

    return predictions;
  }

  /**
   * Calculate probability for over/under total goals using Poisson approximation
   */
  calculateTotalGoalsProbability(expectedTotal, line) {
    // Using simplified Poisson distribution
    // P(X <= k) = sum of e^(-lambda) * lambda^i / i! for i = 0 to k

    const lambda = expectedTotal;
    let cumulativeProb = 0;

    // Calculate P(X <= line) using Poisson CDF
    const k = Math.floor(line);
    for (let i = 0; i <= k; i++) {
      cumulativeProb += (Math.exp(-lambda) * Math.pow(lambda, i)) / this.factorial(i);
    }

    // Handle half lines (e.g., 2.5)
    // For over 2.5, we need P(X >= 3) = 1 - P(X <= 2)
    const underProb = cumulativeProb;
    const overProb = 1 - underProb;

    return {
      over: Math.max(0, Math.min(1, overProb)),
      under: Math.max(0, Math.min(1, underProb))
    };
  }

  /**
   * Factorial helper for Poisson calculation
   */
  factorial(n) {
    if (n <= 1) return 1;
    let result = 1;
    for (let i = 2; i <= n; i++) {
      result *= i;
    }
    return result;
  }

  /**
   * Get all value bets across all leagues
   */
  async getAllValueBets(minProb = 0.58, maxProb = 0.62) {
    const allMatches = await this.getAllTodaysMatches();
    const results = [];

    for (const match of allMatches) {
      try {
        const predictions = await this.generateMatchPredictions(match, minProb, maxProb);

        if (predictions.length > 0) {
          results.push({
            matchId: match.id,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            kickoff: match.utcDate,
            leagueCode: match.leagueCode,
            leagueName: match.leagueName,
            country: match.country,
            oddsSlug: match.oddsSlug,
            predictions: predictions.slice(0, 10)
          });
        }
      } catch (error) {
        console.log(`[Football-Data] Error processing ${match.homeTeam.name} vs ${match.awayTeam.name}: ${error.message}`);
      }
    }

    console.log(`[Football-Data] Generated predictions for ${results.length} matches`);
    return results;
  }

  /**
   * Get league info for odds matching
   */
  getLeagueInfo(code) {
    return this.leagues[code] || null;
  }

  /**
   * Get all supported leagues
   */
  getSupportedLeagues() {
    return Object.entries(this.leagues).map(([code, info]) => ({
      code,
      ...info
    }));
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    console.log('[Football-Data] Cache cleared');
  }
}

module.exports = new FootballDataService();
