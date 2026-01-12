import { Config, LeaderSelection, TraderScore } from "./types";
import { StateStore } from "./state";

function sortScores(scores: TraderScore[]): TraderScore[] {
  return [...scores].sort((a, b) => b.score - a.score);
}

function inCooldown(state: StateStore, proxyWallet: string, cooldownMs: number, now: number): boolean {
  const last = state.getLastSwitchedAway(proxyWallet);
  return last > 0 && now - last < cooldownMs;
}

export function selectLeaders(scores: TraderScore[], config: Config, state: StateStore): LeaderSelection {
  const now = Date.now();
  const eligible = scores.filter((s) => s.eligible);
  const sorted = sortScores(eligible);
  const eligibleCount = eligible.length;

  if (config.followMode === "TOPK") {
    const prev = state.getTopKState().leaders;
    const cooldownFiltered = sorted.filter((s) => !inCooldown(state, s.proxyWallet, config.cooldownMs, now));
    const selected = cooldownFiltered.slice(0, Math.max(1, config.topK));

    const totalPositive = selected.reduce((sum, s) => sum + (s.score > 0 ? s.score : 0), 0);
    if (selected.length === 0 || totalPositive <= 0) {
      for (const prevWallet of prev) {
        state.setSwitchedAway(prevWallet, now);
      }
      state.setTopKState([]);
      const reason =
        selected.length === 0
          ? eligibleCount === 0
            ? "no-eligible-leaders"
            : "cooldown-active"
          : "no-positive-scores";
      return {
        mode: "TOPK",
        leaders: [],
        reason,
        meta: {
          eligibleCount,
          selectedCount: selected.length,
          topK: config.topK,
          totalPositive,
          cooldownFilteredCount: cooldownFiltered.length,
        },
      };
    }
    const leaders = selected.map((s) => ({
      proxyWallet: s.proxyWallet,
      displayName: s.displayName,
      score: s.score,
      weight: Math.max(0, s.score) / totalPositive,
    }));

    const selectedWallets = leaders.map((l) => l.proxyWallet);
    for (const prevWallet of prev) {
      if (!selectedWallets.includes(prevWallet)) {
        state.setSwitchedAway(prevWallet, now);
      }
    }
    state.setTopKState(selectedWallets);

    return {
      mode: "TOPK",
      leaders,
      reason: leaders.length < config.topK ? "topk-insufficient" : "topk-selection",
      meta: {
        eligibleCount,
        selectedCount: leaders.length,
        topK: config.topK,
        totalPositive,
        cooldownFilteredCount: cooldownFiltered.length,
      },
    };
  }

  const best = sorted[0];
  const currentState = state.getLeaderState();
  const currentLeader = currentState.currentLeader;
  const currentSince = currentState.sinceMs || 0;
  const currentScore = scores.find((s) => s.proxyWallet === currentLeader);

  if (!currentLeader && best && !inCooldown(state, best.proxyWallet, config.cooldownMs, now)) {
    state.setLeaderState(best.proxyWallet, now);
    return {
      mode: "LEADER",
      leader: best,
      leaders: [{ proxyWallet: best.proxyWallet, displayName: best.displayName, score: best.score, weight: 1 }],
      reason: "initial-leader",
      meta: { eligibleCount },
    };
  }

  if (!currentLeader || !currentScore || !currentScore.eligible) {
    if (best && !inCooldown(state, best.proxyWallet, config.cooldownMs, now)) {
      if (currentLeader) state.setSwitchedAway(currentLeader, now);
      state.setLeaderState(best.proxyWallet, now);
      return {
        mode: "LEADER",
        leader: best,
        leaders: [{ proxyWallet: best.proxyWallet, displayName: best.displayName, score: best.score, weight: 1 }],
        reason: "current-leader-ineligible",
        meta: { eligibleCount },
      };
    }
    const reason =
      eligibleCount === 0
        ? "no-eligible-leader"
        : best && inCooldown(state, best.proxyWallet, config.cooldownMs, now)
        ? "cooldown-active"
        : "no-eligible-leader";
    return { mode: "LEADER", leaders: [], reason, meta: { eligibleCount } };
  }

  const stopScoreTriggered = currentScore.score < config.stopScore;
  const stopRealizedTriggered = currentScore.realizedPnlSum < config.stopRealizedPnl;
  const stopCondition = stopScoreTriggered || stopRealizedTriggered;
  const holdElapsed = now - currentSince;
  const canSwitch = stopCondition || holdElapsed >= config.minHoldMs;

  if (best && best.proxyWallet !== currentLeader && canSwitch) {
    const threshold = currentScore.score * (1 + config.switchMarginPct);
    if (best.score >= threshold && !inCooldown(state, best.proxyWallet, config.cooldownMs, now)) {
      state.setSwitchedAway(currentLeader, now);
      state.setLeaderState(best.proxyWallet, now);
      const reason = stopScoreTriggered
        ? "stop-score-triggered"
        : stopRealizedTriggered
        ? "stop-realized-pnl-triggered"
        : "score-improvement";
      return {
        mode: "LEADER",
        leader: best,
        leaders: [{ proxyWallet: best.proxyWallet, displayName: best.displayName, score: best.score, weight: 1 }],
        reason,
        meta: {
          eligibleCount,
          holdElapsedMs: holdElapsed,
          minHoldMs: config.minHoldMs,
          stopScore: config.stopScore,
          stopRealizedPnl: config.stopRealizedPnl,
          stopScoreTriggered,
          stopRealizedTriggered,
          stopCondition,
          threshold,
        },
      };
    }
  }

  return {
    mode: "LEADER",
    leader: currentScore,
    leaders: [{
      proxyWallet: currentScore.proxyWallet,
      displayName: currentScore.displayName,
      score: currentScore.score,
      weight: 1,
    }],
    reason: holdElapsed < config.minHoldMs && !stopCondition ? "min-hold-not-satisfied" : "holding-leader",
    meta: {
      eligibleCount,
      holdElapsedMs: holdElapsed,
      minHoldMs: config.minHoldMs,
      stopScore: config.stopScore,
      stopRealizedPnl: config.stopRealizedPnl,
      stopScoreTriggered,
      stopRealizedTriggered,
      stopCondition,
    },
  };
}
