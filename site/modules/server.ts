// The backend of the site's modules, installed by the api and the worker when they start (site/modules/index.ts).
import type { ServerModule } from "@aihot/backend/modules";
import labeling from "@aihot/labeling/server";
import weiboMonitor from "@aihot/weibo-monitor/server";

export const SERVER_MODULES: readonly ServerModule[] = [labeling, weiboMonitor];
