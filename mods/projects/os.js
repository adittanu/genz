// genz: what the mod used from a POSIX shell (mkdir, test, sleep), done so it also runs on Windows, where none of
// those programs is on the PATH Herdr runs commands with.
import * as fs from "fs/promises";
import { exec, window } from "herdr";

/** mkdir -p, for folders under the app home. */
export const mkdirp = (path) => fs.mkdir(path, { recursive: true });

/** test -e, for files and folders in the home folder. */
export const present = (path) => fs.exists(path);

/** Waits `ms`. There is no timer outside a callback's `cx`, so this asks the system to wait. */
export async function sleep(ms) {
  if (window()?.platform === "windows") {
    await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Start-Sleep -Milliseconds ${Math.round(ms)}`]);
    return;
  }
  await exec("sleep", [String(ms / 1000)]);
}
