export type ModelStatus = "idle" | "downloading" | "ready";

export function coerceModelStatus(value: string): ModelStatus {
  switch (value) {
    case "idle":
    case "downloading":
    case "ready":
      return value;
    default:
      return "idle";
  }
}
