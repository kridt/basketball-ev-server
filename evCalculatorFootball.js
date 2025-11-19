// evCalculatorFootball.js - Football/Soccer Probability Calculator

// Standard normal CDF approximation
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const prob =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - prob : prob;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Compute probability + fair odds for a player prop (football)
 *
 * @param {Object} opts
 * @param {number[]} seasonValues - all game values for stat this season
 * @param {number[]} recentValues - last N values (recent form)
 * @param {number} line - prop line (e.g. 0.5 for goals)
 * @param {"over"|"under"} side
 * @param {number} weightRecent - [0,1] (default 0.65 => 65% form, 35% season)
 */
function computePlayerPropProb({
  seasonValues,
  recentValues,
  line,
  side,
  weightRecent = 0.65,
}) {
  if (!seasonValues.length) {
    throw new Error("No season data found for this player/stat");
  }

  const seasonAvg = mean(seasonValues);
  const recentAvg = recentValues.length ? mean(recentValues) : seasonAvg;

  // 65% recent form, 35% season baseline (same as NBA)
  const mu = weightRecent * recentAvg + (1 - weightRecent) * seasonAvg;

  let sigma = recentValues.length ? stdDev(recentValues) : 0;
  if (sigma === 0) {
    // crude fallback: don't pretend zero volatility
    sigma = 0.4 * seasonAvg || 0.5;
  }

  let z, p;
  if (side === "over") {
    // continuity correction
    z = (line + 0.5 - mu) / sigma;
    p = 1 - normalCdf(z);
  } else {
    z = (line - 0.5 - mu) / sigma;
    p = normalCdf(z);
  }

  const fairOdds = 1 / p;

  return {
    seasonAvg,
    recentAvg,
    mu,
    sigma,
    p,
    fairOdds,
  };
}

/**
 * Compute probability for match-level statistics (team totals)
 * This combines both teams' averages similar to the basketball approach
 *
 * @param {Object} opts
 * @param {number[]} homeSeasonValues - home team's season averages
 * @param {number[]} awaySeasonValues - away team's season averages
 * @param {number[]} homeRecentValues - home team's recent form
 * @param {number[]} awayRecentValues - away team's recent form
 * @param {number} line - betting line
 * @param {"over"|"under"} side
 * @param {number} weightRecent - weight for recent form
 */
function computeMatchStatProb({
  homeSeasonValues,
  awaySeasonValues,
  homeRecentValues,
  awayRecentValues,
  line,
  side,
  weightRecent = 0.60, // slightly lower weight for match stats
}) {
  if (!homeSeasonValues.length && !awaySeasonValues.length) {
    throw new Error("No data found for this match stat");
  }

  // Calculate weighted averages for each team
  const homeSeasonAvg = homeSeasonValues.length ? mean(homeSeasonValues) : 0;
  const awaySeasonAvg = awaySeasonValues.length ? mean(awaySeasonValues) : 0;
  const homeRecentAvg = homeRecentValues.length ? mean(homeRecentValues) : homeSeasonAvg;
  const awayRecentAvg = awayRecentValues.length ? mean(awayRecentValues) : awaySeasonAvg;

  // Weighted average for each team
  const homeMu = weightRecent * homeRecentAvg + (1 - weightRecent) * homeSeasonAvg;
  const awayMu = weightRecent * awayRecentAvg + (1 - weightRecent) * awaySeasonAvg;

  // Combined match prediction
  const mu = homeMu + awayMu;

  // Combined standard deviation (independent variables)
  const homeStd = homeRecentValues.length ? stdDev(homeRecentValues) : stdDev(homeSeasonValues);
  const awayStd = awayRecentValues.length ? stdDev(awayRecentValues) : stdDev(awaySeasonValues);
  let sigma = Math.sqrt(homeStd * homeStd + awayStd * awayStd);

  if (sigma === 0 || !isFinite(sigma)) {
    sigma = 0.3 * mu || 1;
  }

  let z, p;
  if (side === "over") {
    z = (line + 0.5 - mu) / sigma;
    p = 1 - normalCdf(z);
  } else {
    z = (line - 0.5 - mu) / sigma;
    p = normalCdf(z);
  }

  const fairOdds = 1 / p;

  return {
    homeAvg: homeMu,
    awayAvg: awayMu,
    matchPrediction: mu,
    sigma,
    p,
    fairOdds,
  };
}

module.exports = {
  computePlayerPropProb,
  computeMatchStatProb,
  mean,
  stdDev,
};
