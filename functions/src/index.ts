import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions/v2";

initializeApp();
setGlobalOptions({ region: "australia-southeast1", maxInstances: 10 });

export { initiateClaim } from "./functions/claims/initiateClaim.js";
export { mergeClaimTask } from "./functions/claims/mergeClaim.js";
export { revertClaim } from "./functions/claims/revertClaim.js";
export { resolveContest } from "./functions/claims/resolveContest.js";

export { onStatsImport } from "./functions/imports/onStatsImport.js";

export { onMatchStarted } from "./functions/matches/onMatchStarted.js";
export { onOverCompleted } from "./functions/matches/onOverCompleted.js";
export { onMatchCompleted } from "./functions/matches/onMatchCompleted.js";

export { getAvailablePlayers } from "./functions/tools/getAvailablePlayers.js";
export { getClubPlayerStats } from "./functions/tools/getClubPlayerStats.js";
export { getPlayerStats } from "./functions/tools/getPlayerStats.js";
export { getPlayerForm } from "./functions/tools/getPlayerForm.js";
export { getBattingInsights } from "./functions/tools/getBattingInsights.js";
export { getBowlingInsights } from "./functions/tools/getBowlingInsights.js";
export { getHeadToHead } from "./functions/tools/getHeadToHead.js";
export { getMatchContext } from "./functions/tools/getMatchContext.js";

export { generateApiKey } from "./functions/apiKeys/generateApiKey.js";
