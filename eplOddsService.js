// eplOddsService.js - EPL/Soccer Odds Service
// Fetches real bookmaker odds for EPL matches

const fetch = require('node-fetch');

class EPLOddsService {
  constructor() {
    // Using the same odds API as the NBA service
    this.apiKey = process.env.ODDS_API_KEY || '811e5fb0efa75d2b92e800cb55b60b30f62af8c21da06c4b2952eb516bee0a2e';
    this.baseUrl = 'https://api.odds-api.io/v3';
    this.oddsCache = new Map(); // Cache odds for 5 minutes
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Search for football matches by team name (all leagues)
   */
  async searchEPLMatches(teamName, leagueFilter = null) {
    try {
      const encodedTeam = encodeURIComponent(teamName);
      const url = `${this.baseUrl}/events/search?apiKey=${this.apiKey}&query=${encodedTeam}`;

      console.log(`[Odds] Searching for matches: ${teamName}`);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Odds API error: ${response.status} ${response.statusText}`);
      }

      const matches = await response.json();

      // Supported league slugs for filtering
      const supportedLeagues = [
        'england-premier-league', 'eng-premier-league',
        'germany-bundesliga', 'ger-bundesliga',
        'italy-serie-a', 'ita-serie-a',
        'spain-la-liga', 'esp-la-liga', 'spain-primera-division',
        'france-ligue-1', 'fra-ligue-1',
        'uefa-champions-league', 'champions-league',
        'uefa-europa-league', 'europa-league',
        'uefa-conference-league', 'conference-league'
      ];

      // Filter for supported football matches (exclude simulated reality league)
      const footballMatches = matches.filter(match => {
        if (match.status !== 'pending') return false;
        if (new Date(match.date) <= new Date()) return false;

        // Exclude simulated/virtual leagues
        const leagueName = match.league?.name?.toLowerCase() || '';
        const leagueSlug = match.league?.slug?.toLowerCase() || '';
        if (leagueName.includes('simulated') || leagueName.includes('srl') ||
            leagueName.includes('virtual') || leagueName.includes('esports')) {
          return false;
        }

        // Check if league is in our supported list or contains known league names
        const isSupported = supportedLeagues.some(sl => leagueSlug.includes(sl) || sl.includes(leagueSlug)) ||
          leagueName.includes('premier league') ||
          leagueName.includes('bundesliga') ||
          leagueName.includes('serie a') ||
          leagueName.includes('la liga') ||
          leagueName.includes('ligue 1') ||
          leagueName.includes('champions league') ||
          leagueName.includes('europa league');

        // If a specific league filter is provided, use it
        if (leagueFilter) {
          return leagueSlug.includes(leagueFilter.toLowerCase()) ||
                 leagueName.includes(leagueFilter.toLowerCase());
        }

        return isSupported;
      }).sort((a, b) => new Date(a.date) - new Date(b.date));

      console.log(`[Odds] Found ${footballMatches.length} football matches for "${teamName}"`);
      return footballMatches;
    } catch (error) {
      console.error('[Odds] Error searching matches:', error.message);
      return [];
    }
  }

  /**
   * Get upcoming EPL matches (next 7 days)
   */
  async getUpcomingEPLMatches() {
    try {
      // Get matches for the next week
      const startDate = new Date().toISOString().slice(0, 10);
      const endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const url = `${this.baseUrl}/events?apiKey=${this.apiKey}&sport=soccer&league=england-premier-league&dateFrom=${startDate}&dateTo=${endDate}`;

      console.log(`[EPL Odds] Fetching upcoming EPL matches...`);

      const response = await fetch(url);
      if (!response.ok) {
        // Try alternative endpoint
        const altUrl = `${this.baseUrl}/events/search?apiKey=${this.apiKey}&query=premier+league`;
        const altResponse = await fetch(altUrl);
        if (!altResponse.ok) {
          throw new Error(`Odds API error: ${response.status}`);
        }
        const altMatches = await altResponse.json();
        return altMatches.filter(m =>
          m.status === 'pending' &&
          (m.league?.slug?.includes('premier') || m.league?.name?.toLowerCase().includes('premier'))
        );
      }

      const matches = await response.json();
      return matches.filter(m => m.status === 'pending');
    } catch (error) {
      console.error('[EPL Odds] Error fetching upcoming matches:', error.message);
      return [];
    }
  }

  /**
   * Get odds for a specific event from multiple bookmakers
   */
  async getEventOdds(eventId) {
    // Check cache first
    const cacheKey = `odds_${eventId}`;
    const cached = this.oddsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      console.log(`[EPL Odds] Using cached odds for event ${eventId}`);
      return cached.data;
    }

    try {
      // Request odds from allowed bookmakers (API subscription limited to these Danish/Nordic bookmakers)
      const bookmakers = 'Bet365,Unibet DK,Betano,NordicBet,Betsson,Betinia DK,Expekt DK,LeoVegas DK,Campobet DK,Kambi';
      const url = `${this.baseUrl}/odds?apiKey=${this.apiKey}&eventId=${eventId}&bookmakers=${encodeURIComponent(bookmakers)}`;

      console.log(`[EPL Odds] Fetching odds for event ${eventId}`);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Odds API error: ${response.status} ${response.statusText}`);
      }

      const oddsData = await response.json();

      // Cache the result
      this.oddsCache.set(cacheKey, { data: oddsData, timestamp: Date.now() });

      console.log(`[EPL Odds] Received odds from bookmakers:`, Object.keys(oddsData.bookmakers || {}));
      return oddsData;
    } catch (error) {
      console.error('[EPL Odds] Error fetching odds:', error.message);
      return null;
    }
  }

  /**
   * Find match between two teams with league and date filtering
   * @param {string} homeTeam - Home team name
   * @param {string} awayTeam - Away team name
   * @param {string} leagueSlug - League slug for filtering (e.g., 'england-premier-league')
   * @param {string} kickoffDate - Expected kickoff date/time for validation
   */
  async findMatch(homeTeam, awayTeam, leagueSlug = null, kickoffDate = null) {
    // Try searching for home team first, with league filter
    const matches = await this.searchEPLMatches(homeTeam, leagueSlug);

    // Find match with matching away team (exclude SRL/simulated teams)
    const match = matches.find(m => {
      const home = m.home?.toLowerCase() || '';
      const away = m.away?.toLowerCase() || '';
      const homeSearch = homeTeam.toLowerCase();
      const awaySearch = awayTeam.toLowerCase();

      // Skip simulated reality league teams
      if (home.includes(' srl') || away.includes(' srl')) {
        return false;
      }

      // If kickoff date provided, validate it's the same day (within 24 hours)
      if (kickoffDate) {
        const matchDate = new Date(m.date);
        const expectedDate = new Date(kickoffDate);
        const hoursDiff = Math.abs(matchDate - expectedDate) / (1000 * 60 * 60);
        if (hoursDiff > 24) {
          console.log(`[EPL Odds] Skipping ${m.home} vs ${m.away} - wrong date (${m.date} vs ${kickoffDate})`);
          return false;
        }
      }

      // Check if teams match (partial matching for flexibility)
      return (home.includes(homeSearch) || homeSearch.includes(home.split(' ')[0])) &&
             (away.includes(awaySearch) || awaySearch.includes(away.split(' ')[0]));
    });

    if (match) {
      console.log(`[EPL Odds] Found match: ${match.home} vs ${match.away} (ID: ${match.id}, League: ${match.league?.name || 'unknown'})`);
    } else {
      console.log(`[EPL Odds] No match found for ${homeTeam} vs ${awayTeam} (league: ${leagueSlug || 'any'})`);
    }

    return match;
  }

  /**
   * Get total goals odds for a match
   */
  async getMatchTotalsOdds(homeTeam, awayTeam) {
    try {
      const match = await this.findMatch(homeTeam, awayTeam);
      if (!match) {
        return null;
      }

      const oddsData = await this.getEventOdds(match.id);
      if (!oddsData || !oddsData.bookmakers) {
        return null;
      }

      const result = {
        matchId: match.id,
        homeTeam: match.home,
        awayTeam: match.away,
        kickoff: match.date,
        markets: {}
      };

      // Process each bookmaker
      for (const [bookmakerName, bookmakerOdds] of Object.entries(oddsData.bookmakers)) {
        // Look for totals/over-under markets
        const totalMarkets = bookmakerOdds.filter(market =>
          market.name?.toLowerCase().includes('total') ||
          market.name?.toLowerCase().includes('over') ||
          market.name?.toLowerCase().includes('goals')
        );

        for (const market of totalMarkets) {
          if (!market.odds) continue;

          for (const odd of market.odds) {
            const line = odd.hdp || odd.handicap || odd.line;
            if (line === undefined) continue;

            const marketKey = `${market.name}_${line}`;
            if (!result.markets[marketKey]) {
              result.markets[marketKey] = {
                marketName: market.name,
                line: line,
                bookmakers: []
              };
            }

            result.markets[marketKey].bookmakers.push({
              bookmaker: bookmakerName,
              overOdds: parseFloat(odd.over) || null,
              underOdds: parseFloat(odd.under) || null,
              updatedAt: market.updatedAt
            });
          }
        }
      }

      console.log(`[EPL Odds] Found ${Object.keys(result.markets).length} markets for ${homeTeam} vs ${awayTeam}`);
      return result;

    } catch (error) {
      console.error('[EPL Odds] Error getting match totals:', error.message);
      return null;
    }
  }

  /**
   * Get corners odds for a match
   */
  async getMatchCornersOdds(homeTeam, awayTeam) {
    try {
      const match = await this.findMatch(homeTeam, awayTeam);
      if (!match) return null;

      const oddsData = await this.getEventOdds(match.id);
      if (!oddsData || !oddsData.bookmakers) return null;

      const result = {
        matchId: match.id,
        homeTeam: match.home,
        awayTeam: match.away,
        markets: {}
      };

      for (const [bookmakerName, bookmakerOdds] of Object.entries(oddsData.bookmakers)) {
        const cornerMarkets = bookmakerOdds.filter(market =>
          market.name?.toLowerCase().includes('corner')
        );

        for (const market of cornerMarkets) {
          if (!market.odds) continue;

          for (const odd of market.odds) {
            const line = odd.hdp || odd.handicap || odd.line;
            if (line === undefined) continue;

            const marketKey = `corners_${line}`;
            if (!result.markets[marketKey]) {
              result.markets[marketKey] = {
                marketName: market.name,
                line: line,
                bookmakers: []
              };
            }

            result.markets[marketKey].bookmakers.push({
              bookmaker: bookmakerName,
              overOdds: parseFloat(odd.over) || null,
              underOdds: parseFloat(odd.under) || null
            });
          }
        }
      }

      return result;
    } catch (error) {
      console.error('[EPL Odds] Error getting corners odds:', error.message);
      return null;
    }
  }

  /**
   * Get cards odds for a match
   */
  async getMatchCardsOdds(homeTeam, awayTeam) {
    try {
      const match = await this.findMatch(homeTeam, awayTeam);
      if (!match) return null;

      const oddsData = await this.getEventOdds(match.id);
      if (!oddsData || !oddsData.bookmakers) return null;

      const result = {
        matchId: match.id,
        homeTeam: match.home,
        awayTeam: match.away,
        markets: {}
      };

      for (const [bookmakerName, bookmakerOdds] of Object.entries(oddsData.bookmakers)) {
        const cardMarkets = bookmakerOdds.filter(market =>
          market.name?.toLowerCase().includes('card') ||
          market.name?.toLowerCase().includes('booking')
        );

        for (const market of cardMarkets) {
          if (!market.odds) continue;

          for (const odd of market.odds) {
            const line = odd.hdp || odd.handicap || odd.line;
            if (line === undefined) continue;

            const marketKey = `cards_${line}`;
            if (!result.markets[marketKey]) {
              result.markets[marketKey] = {
                marketName: market.name,
                line: line,
                bookmakers: []
              };
            }

            result.markets[marketKey].bookmakers.push({
              bookmaker: bookmakerName,
              overOdds: parseFloat(odd.over) || null,
              underOdds: parseFloat(odd.under) || null
            });
          }
        }
      }

      return result;
    } catch (error) {
      console.error('[EPL Odds] Error getting cards odds:', error.message);
      return null;
    }
  }

  /**
   * Get all available odds for a match (goals, corners, cards)
   * @param {string} homeTeam - Home team name
   * @param {string} awayTeam - Away team name
   * @param {string} leagueSlug - League slug for filtering (e.g., 'england-premier-league')
   * @param {string} kickoffDate - Expected kickoff date/time for validation
   */
  async getAllMatchOdds(homeTeam, awayTeam, leagueSlug = null, kickoffDate = null) {
    try {
      const match = await this.findMatch(homeTeam, awayTeam, leagueSlug, kickoffDate);
      if (!match) {
        console.log(`[EPL Odds] Match not found for ${homeTeam} vs ${awayTeam} (league: ${leagueSlug || 'any'})`);
        return null;
      }

      const oddsData = await this.getEventOdds(match.id);
      if (!oddsData || !oddsData.bookmakers) {
        console.log(`[EPL Odds] No odds data for ${homeTeam} vs ${awayTeam}`);
        return null;
      }

      const result = {
        matchId: match.id,
        homeTeam: match.home,
        awayTeam: match.away,
        kickoff: match.date,
        odds: {
          goals: [],
          corners: [],
          cards: [],
          shots: [],
          other: []
        }
      };

      // Map stat keys to market types
      const marketTypeMap = {
        'total': 'goals',
        'goal': 'goals',
        'corner': 'corners',
        'card': 'cards',
        'booking': 'cards',
        'shot': 'shots'
      };

      for (const [bookmakerName, bookmakerOdds] of Object.entries(oddsData.bookmakers)) {
        if (!Array.isArray(bookmakerOdds)) continue;

        for (const market of bookmakerOdds) {
          if (!market.odds || !market.name) continue;

          // Determine market type
          const marketNameLower = market.name.toLowerCase();
          let marketType = 'other';
          for (const [keyword, type] of Object.entries(marketTypeMap)) {
            if (marketNameLower.includes(keyword)) {
              marketType = type;
              break;
            }
          }

          for (const odd of market.odds) {
            const line = odd.hdp || odd.handicap || odd.line;
            if (line === undefined) continue;

            const oddEntry = {
              marketName: market.name,
              line: parseFloat(line),
              bookmaker: bookmakerName,
              overOdds: parseFloat(odd.over) || null,
              underOdds: parseFloat(odd.under) || null,
              updatedAt: market.updatedAt
            };

            result.odds[marketType].push(oddEntry);
          }
        }
      }

      console.log(`[EPL Odds] Collected odds - Goals: ${result.odds.goals.length}, Corners: ${result.odds.corners.length}, Cards: ${result.odds.cards.length}`);
      return result;

    } catch (error) {
      console.error('[EPL Odds] Error getting all match odds:', error.message);
      return null;
    }
  }

  /**
   * Find best odds for a specific stat prediction
   * @param {Object} prediction - Our prediction with statKey, line, side
   * @param {Object} matchOdds - Match odds from getAllMatchOdds
   * @returns {Object} Best bookmaker odds
   */
  findBestOddsForPrediction(prediction, matchOdds) {
    if (!matchOdds || !matchOdds.odds) return null;

    // Map our stat keys to odds API market types
    const statToMarketMap = {
      'goals': 'goals',
      'corners': 'corners',
      'corner_taken': 'corners',
      'yellow_cards': 'cards',
      'red_cards': 'cards',
      'total_yel_card': 'cards',
      'shots_on_target': 'shots',
      'ontarget_scoring_att': 'shots',
      'offsides': 'other',
      'fouls': 'other'
    };

    const marketType = statToMarketMap[prediction.statKey] || 'other';
    const marketOdds = matchOdds.odds[marketType] || [];

    if (marketOdds.length === 0) {
      return null;
    }

    // Find odds matching our line (within 0.5 tolerance)
    const lineTolerance = 0.5;
    const matchingOdds = marketOdds.filter(odd =>
      Math.abs(odd.line - prediction.line) <= lineTolerance
    );

    if (matchingOdds.length === 0) {
      // Try to find closest line
      const closestOdd = marketOdds.reduce((closest, odd) => {
        const diff = Math.abs(odd.line - prediction.line);
        const closestDiff = Math.abs(closest.line - prediction.line);
        return diff < closestDiff ? odd : closest;
      }, marketOdds[0]);

      if (Math.abs(closestOdd.line - prediction.line) <= 2) {
        matchingOdds.push(closestOdd);
      }
    }

    if (matchingOdds.length === 0) return null;

    // Find best odds based on side (over or under)
    const oddsKey = prediction.side === 'over' ? 'overOdds' : 'underOdds';

    let bestOdd = null;
    let bestOddsValue = 0;

    for (const odd of matchingOdds) {
      const oddsValue = odd[oddsKey];
      if (oddsValue && oddsValue > bestOddsValue) {
        bestOddsValue = oddsValue;
        bestOdd = odd;
      }
    }

    if (!bestOdd) return null;

    // Collect all bookmakers for this line
    const allBookmakers = matchingOdds
      .filter(odd => odd[oddsKey])
      .map(odd => ({
        bookmaker: odd.bookmaker,
        odds: odd[oddsKey],
        line: odd.line
      }))
      .sort((a, b) => b.odds - a.odds);

    return {
      bestBookmaker: bestOdd.bookmaker,
      bestOdds: bestOddsValue,
      line: bestOdd.line,
      marketName: bestOdd.marketName,
      allBookmakers: allBookmakers
    };
  }

  /**
   * Calculate EV given our probability and bookmaker odds
   */
  calculateEV(ourProbability, decimalOdds) {
    // EV = (probability × odds) - 1
    const ev = (ourProbability * decimalOdds) - 1;
    return ev * 100; // Return as percentage
  }

  /**
   * Clear the odds cache
   */
  clearCache() {
    this.oddsCache.clear();
    console.log('[EPL Odds] Cache cleared');
  }
}

module.exports = new EPLOddsService();
