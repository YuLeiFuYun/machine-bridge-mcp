export interface AlarmStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export async function writeEarliestRuntimeAlarm(input: {
  storage: AlarmStorage;
  nextDeadline: number;
  now: number;
  onError: (error: unknown) => void;
  onMutation?: (action: "set" | "delete" | "noop") => void;
  currentAlarm?: number | null;
}): Promise<void> {
  try {
    const current = input.currentAlarm === undefined ? await input.storage.getAlarm() : input.currentAlarm;
    if (!Number.isFinite(input.nextDeadline)) {
      if (current === null) {
        input.onMutation?.("noop");
        return;
      }
      await input.storage.deleteAlarm();
      input.onMutation?.("delete");
      return;
    }
    const target = Math.max(input.now, input.nextDeadline);
    if (current !== null && current > input.now && current <= target) {
      input.onMutation?.("noop");
      return;
    }
    await input.storage.setAlarm(target);
    input.onMutation?.("set");
  } catch (error) {
    try { input.onError(error); }
    catch { /* Alarm persistence already failed; observer failure cannot repair that storage outcome. */ }
  }
}
