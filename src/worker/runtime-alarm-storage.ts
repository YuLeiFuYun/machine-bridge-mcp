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
}): Promise<void> {
  try {
    const current = await input.storage.getAlarm();
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
    input.onError(error);
  }
}
