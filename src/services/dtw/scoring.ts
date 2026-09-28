/**
 * @file scoring.ts
 * @description Kinetic energy anti-idle gating, sigmoidal score calibration,
 * two-tier verification (handshape vs. spatial path submetrics), and competitor disambiguation.
 */

export interface ScoringResult {
  score: number;
  passed: boolean;
  status: 'MATCH' | 'DIFFERENT_SIGN' | 'UNCERTAIN' | 'IDLE_STATIONARY';
  handshapeScore: number;
  spatialPathScore: number;
  feedback: string;
  disambiguation?: string | null;
}

export interface CompetitorEvaluation {
  signName: string;
  score: number;
}

export const KINETIC_ENERGY_THRESHOLD = 0.04;
export const PASSING_THRESHOLD = 52;
export const SUBMETRIC_THRESHOLD = 50;

/**
 * Calculates the total kinetic energy (wrist path trajectory distance) over a sequence:
 * E_k = sum_{t=1..N} (||u_wrist(t) - u_wrist(t-1)||_2)
 *
 * Left wrist is at indices [18, 19], Right wrist is at indices [20, 21].
 * Also incorporates anchor displacement [108..111].
 *
 * @param frames Array of Float32Array(112) Siformer feature frames.
 * @returns Total accumulated motion energy E_k.
 */
export function calculateKineticEnergy(frames: Float32Array[]): number {
  if (frames.length < 2) return 0;

  let totalEnergy = 0;
  for (let t = 1; t < frames.length; t++) {
    const prev = frames[t - 1];
    const curr = frames[t];

    // Left wrist motion
    const lwDx = curr[18] - prev[18];
    const lwDy = curr[19] - prev[19];
    const lwDist = Math.sqrt(lwDx * lwDx + lwDy * lwDy);

    // Right wrist motion
    const rwDx = curr[20] - prev[20];
    const rwDy = curr[21] - prev[21];
    const rwDist = Math.sqrt(rwDx * rwDx + rwDy * rwDy);

    // Anchor motion
    const laDx = curr[108] - prev[108];
    const laDy = curr[109] - prev[109];
    const laDist = Math.sqrt(laDx * laDx + laDy * laDy);

    const raDx = curr[110] - prev[110];
    const raDy = curr[111] - prev[111];
    const raDist = Math.sqrt(raDx * raDx + raDy * raDy);

    totalEnergy += Math.max(lwDist, laDist) + Math.max(rwDist, raDist);
  }

  return totalEnergy;
}

/**
 * Calibrates average alignment cost to a 0-100% confidence score using a sigmoid function:
 * Score = clamp(0, 100, round(100 / (1 + exp(1.75 * (avg_cost - 2.2)))))
 *
 * @param avgCost Normalized average DTW alignment cost per step.
 * @returns Calibrated integer score in range [0, 100].
 */
export function sigmoidScore(avgCost: number): number {
  if (!Number.isFinite(avgCost) || avgCost < 0) return 0;
  const raw = 100 / (1 + Math.exp(1.75 * (avgCost - 2.2)));
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Two-tier verification evaluating overall score, handshape submetric, and spatial path submetric.
 *
 * @param avgCost Overall DTW alignment cost.
 * @param handCost Isolated hand shape submetric cost.
 * @param pathCost Isolated spatial path & anchor submetric cost.
 * @param kineticEnergy Accumulated motion energy.
 * @param templateRequiresMovement Whether the template expects dynamic motion.
 * @param competitors Optional list of evaluations against other signs for contrastive separation & disambiguation.
 */
export function evaluateScoring(
  avgCost: number,
  handCost: number,
  pathCost: number,
  kineticEnergy: number,
  templateRequiresMovement: boolean = true,
  competitors?: CompetitorEvaluation[]
): ScoringResult {
  // 1. Anti-Idle Guardrail
  if (templateRequiresMovement && kineticEnergy < KINETIC_ENERGY_THRESHOLD) {
    return {
      score: 0,
      passed: false,
      status: 'IDLE_STATIONARY',
      handshapeScore: 0,
      spatialPathScore: 0,
      feedback: 'Movement required. Please perform the sign trajectory rather than holding still.'
    };
  }

  // 2. Calibrate Scores
  let baseScore = sigmoidScore(avgCost);
  const handshapeScore = sigmoidScore(handCost);
  const spatialPathScore = sigmoidScore(pathCost);

  // 3. Contrastive Separation Bonus
  if (competitors && competitors.length > 0) {
    let topCompetitorScore = -1;
    let topCompetitorName = '';

    for (const comp of competitors) {
      if (comp.score > topCompetitorScore) {
        topCompetitorScore = comp.score;
        topCompetitorName = comp.signName;
      }
    }

    // Lead margin threshold: >= 8 points
    if (baseScore - topCompetitorScore >= 8) {
      baseScore = Math.min(100, baseScore + 8);
    }

    // Disambiguation Trigger: Target < 45% AND Competitor >= 65% AND (Competitor - Target) > 25%
    if (
      baseScore < 45 &&
      topCompetitorScore >= 65 &&
      topCompetitorScore - baseScore > 25
    ) {
      return {
        score: baseScore,
        passed: false,
        status: 'DIFFERENT_SIGN',
        handshapeScore,
        spatialPathScore,
        feedback: `Did you mean: ${topCompetitorName}?`,
        disambiguation: topCompetitorName
      };
    }
  }

  // 4. Two-Tier Threshold Verification
  const passedBase = baseScore >= PASSING_THRESHOLD;
  const passedHand = handshapeScore >= SUBMETRIC_THRESHOLD;
  const passedPath = spatialPathScore >= SUBMETRIC_THRESHOLD;
  const fullyPassed = passedBase && passedHand && passedPath;

  let feedback = 'Try matching the hand shape and movement path.';
  if (fullyPassed) {
    feedback = 'Sign achieved. Beautifully done!';
  } else if (passedPath && !passedHand) {
    feedback = 'Movement path correct, but check your hand shape.';
  } else if (passedHand && !passedPath) {
    feedback = 'Hand shape correct, but follow the movement path.';
  }

  return {
    score: baseScore,
    passed: fullyPassed,
    status: fullyPassed ? 'MATCH' : baseScore >= 35 ? 'UNCERTAIN' : 'DIFFERENT_SIGN',
    handshapeScore,
    spatialPathScore,
    feedback
  };
}
