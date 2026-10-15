/**
 * Where a room's seats run. Pure so the choice is testable without a bb server.
 *
 * `project-default` lets bb pick the machine, and bb picks the server. A project
 * whose checkout lives only on another machine then fails every spawn with
 * "Project has no local-path source for host", so rooms carry an explicit
 * machine and spawn there instead.
 */

export type SeatEnvironment =
  | { type: "reuse"; environmentId: string }
  | {
      type: "host";
      hostId: string;
      workspace:
        | { type: "managed-worktree"; baseBranch: { kind: "default" } }
        | { type: "unmanaged"; path: null };
    }
  | { type: "project-default" };

export function seatEnvironment(
  room: { environmentId: string | null; hostId: string | null },
  project: { gitRemoteUrl: string | null },
): SeatEnvironment {
  if (room.environmentId !== null) return { type: "reuse", environmentId: room.environmentId };
  if (room.hostId === null) return { type: "project-default" };
  // Seats share one workspace. For a git project that is a fresh worktree, so
  // agents never edit the machine's main checkout; otherwise the checkout itself.
  return {
    type: "host",
    hostId: room.hostId,
    workspace: project.gitRemoteUrl !== null
      ? { type: "managed-worktree", baseBranch: { kind: "default" } }
      : { type: "unmanaged", path: null },
  };
}

/** The machine holding the project's default checkout, or null for a project with no sources. */
export function defaultSourceHost(sources: readonly { hostId: string; isDefault: boolean }[]): string | null {
  return (sources.find((s) => s.isDefault) ?? sources[0])?.hostId ?? null;
}

/** Resolve a machine selector the way `bb --machine` does: exact id, else an unambiguous name. */
export function resolveMachine(selector: string, hosts: readonly { id: string; name: string }[]): string {
  const byId = hosts.find((h) => h.id === selector);
  if (byId !== undefined) return byId.id;
  const byName = hosts.filter((h) => h.name === selector);
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) throw new Error(`machine name "${selector}" is ambiguous; pass its id (${byName.map((h) => h.id).join(", ")})`);
  throw new Error(`unknown machine "${selector}"; see \`bb machine list\``);
}

export interface MachineOption {
  id: string;
  name: string;
  connected: boolean;
  isDefault: boolean;
}

/**
 * The machines a room in this project can run on: those holding one of its
 * checkouts, default first. Any other machine fails the first spawn with
 * "Project has no local-path source for host", so the picker offers only these.
 */
export function projectMachines(
  sources: readonly { hostId: string; isDefault: boolean }[],
  hosts: readonly { id: string; name: string; status: string }[],
): MachineOption[] {
  const defaultHost = defaultSourceHost(sources);
  const options: MachineOption[] = [];
  for (const host of hosts) {
    if (!sources.some((s) => s.hostId === host.id)) continue;
    options.push({ id: host.id, name: host.name, connected: host.status === "connected", isDefault: host.id === defaultHost });
  }
  return options.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

/** Resolve a machine selector and require that it holds a checkout of the project. */
export function machineForProject(
  selector: string,
  sources: readonly { hostId: string }[],
  hosts: readonly { id: string; name: string }[],
): string {
  const hostId = resolveMachine(selector, hosts);
  if (!sources.some((s) => s.hostId === hostId)) {
    const name = hosts.find((h) => h.id === hostId)?.name ?? hostId;
    throw new Error(`there is no checkout of this project on ${name}; add a source for it in the project's settings first`);
  }
  return hostId;
}
