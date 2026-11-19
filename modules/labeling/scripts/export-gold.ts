// Writes the owner's labels as the selection eval's gold set (default .data/gold.jsonl, which
// scripts/eval-selection.ts reads without arguments):
//   node --env-file=.env modules/labeling/scripts/export-gold.ts [--out .data/gold.jsonl]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { closeDb } from "@aihot/backend/db";
import { goldLines } from "../backend/marks.ts";

const { values } = parseArgs({ options: { out: { type: "string", default: ".data/gold.jsonl" } } });
const out = path.resolve(values.out!);
const lines = await goldLines();
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, lines.length ? `${lines.join("\n")}\n` : "");
console.log(`${lines.length} labels → ${out}`);
await closeDb();
