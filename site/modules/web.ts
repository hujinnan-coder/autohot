// What the site's modules add to the web pages (site/modules/index.ts).
import type { WebModule } from "@aihot/web/modules";
import following from "@aihot/following/web";
import readerAccounts from "@aihot/reader-accounts/web";

export const WEB_MODULES: readonly WebModule[] = [following, readerAccounts];
