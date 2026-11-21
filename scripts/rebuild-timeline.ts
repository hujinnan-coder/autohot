// Run once at the publication-time cutover with API and worker writers stopped.
// Also resets every publication's sort_at to timeline_at.
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
