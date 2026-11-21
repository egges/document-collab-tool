/** "Show in Finder" on macOS, "Show in Explorer" on Windows, "Show in Files" elsewhere. */
export function showInFolderLabel(userAgent: string = navigator.userAgent): string {
  if (/Mac OS X|Macintosh/.test(userAgent)) return "Show in Finder";
  if (/Windows/.test(userAgent)) return "Show in Explorer";
  return "Show in Files";
}
