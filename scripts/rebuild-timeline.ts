// Run once at the publication-time cutover with API and worker writers stopped.
import { closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { rebuildPublicationTimeline } from "@aihot/backend/publication/publish";
import { SERVER_MODULES } from "@aihot/site/modules/server";

installModules(SERVER_MODULES);
try {
  console.log(await rebuildPublicationTimeline());
} finally {
  await closeDb();
}
