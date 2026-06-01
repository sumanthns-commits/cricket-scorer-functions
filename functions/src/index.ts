import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions/v2";

initializeApp();
setGlobalOptions({ region: "australia-southeast1", maxInstances: 10 });

export { onStatsImport } from "./functions/imports/onStatsImport.js";

export { onMatchStarted } from "./functions/matches/onMatchStarted.js";
export { onOverCompleted } from "./functions/matches/onOverCompleted.js";
export { onMatchCompleted } from "./functions/matches/onMatchCompleted.js";

export { linkGhostPlayer } from "./functions/players/linkGhostPlayer.js";
export { unlinkPlayer } from "./functions/players/unlinkPlayer.js";

export { getAvailablePlayers } from "./functions/tools/getAvailablePlayers.js";
export { getClubPlayerStats } from "./functions/tools/getClubPlayerStats.js";
export { getPlayerStats } from "./functions/tools/getPlayerStats.js";
export { getPlayerForm } from "./functions/tools/getPlayerForm.js";
export { getBattingInsights } from "./functions/tools/getBattingInsights.js";
export { getBowlingInsights } from "./functions/tools/getBowlingInsights.js";
export { getHeadToHead } from "./functions/tools/getHeadToHead.js";
export { getMatchContext } from "./functions/tools/getMatchContext.js";

export { generateApiKey } from "./functions/apiKeys/generateApiKey.js";
