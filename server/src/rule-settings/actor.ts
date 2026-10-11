// Who made a rule change or a tag write: the HotCRP token's own account
// (GET /whoami), looked up once per process and cached. If HotCRP can't be
// reached the change still goes through, attributed to UNKNOWN_ACTOR; a
// rule change never needs HotCRP.

export type ActorResolver = () => Promise<string>;

export const UNKNOWN_ACTOR = "chair (whoami unavailable)";

export function whoamiActor(client: { whoami(): Promise<{ email: string }> }): ActorResolver {
  let cached: string | undefined;
  return async () => {
    if (cached) return cached;
    try {
      cached = (await client.whoami()).email.toLowerCase();
      return cached;
    } catch {
      return UNKNOWN_ACTOR;
    }
  };
}

/** For servers and tests without HotCRP. */
export const fixedActor =
  (who: string): ActorResolver =>
  async () =>
    who;
