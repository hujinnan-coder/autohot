import type { ReaderPreview as Preview } from "@aihot/contracts/reader";
import { webModules } from "../site-modules";

export function ReaderPreview(props: { preview: Preview; returnTo: string }) {
  const View = webModules().find((module) => module.readerPreview)?.readerPreview;
  return View ? <View {...props} /> : null;
}
