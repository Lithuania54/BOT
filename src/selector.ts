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

  if (config.followMode === "TOPK") {
    const prev = state.getTopKState().leaders;
    const selected = sorted.filter((s) => !inCooldown(state, s.proxyWallet, config.cooldownMs, now))
      .slice(0, Math.max(1, config.topK));

    const totalPositive = selected.reduce((sum, s) => sum + (s.score > 0 ? s.score : 0), 0);
    const leaders = selected.map((s) => ({
      proxyWallet: s.proxyWallet,
      displayName: s.displayName,
      score: s.score,
      weight: totalPositive > 0 ? Math.max(0, s.score) / totalPositive : 1 / selected.length,
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
      reason: leaders.length ? "topk selection" : "no eligible leaders",
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
      reason: "initial leader",
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
        reason: "current leader not eligible",
      };
    }
    return { mode: "LEADER", leaders: [], reason: "no eligible leader" };
  }

  const stopCondition =
    currentScore.score < config.stopScore || currentScore.realizedPnlSum < config.stopRealizedPnl;
  const holdElapsed = now - currentSince;
  const canSwitch = stopCondition || holdElapsed >= config.minHoldMs;

  if (best && best.proxyWallet !== currentLeader && canSwitch) {
    const threshold = currentScore.score * (1 + config.switchMarginPct);
    if (best.score >= threshold && !inCooldown(state, best.proxyWallet, config.cooldownMs, now)) {
      state.setSwitchedAway(currentLeader, now);
      state.setLeaderState(best.proxyWallet, now);
      return {
        mode: "LEADER",
        leader: best,
        leaders: [{ proxyWallet: best.proxyWallet, displayName: best.displayName, score: best.score, weight: 1 }],
        reason: stopCondition ? "stop condition" : "score improvement",
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
    reason: "holding leader",
  };
}
