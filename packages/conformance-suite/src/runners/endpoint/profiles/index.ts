import type { ProfileName } from "../http.js";
import { submissionsProfile } from "./submissions.js";
import type { Profile } from "./types.js";

export function profileFor(_name: ProfileName): Profile {
  return submissionsProfile;
}

export { submissionsProfile };
export type { CheckParts, Profile } from "./types.js";
