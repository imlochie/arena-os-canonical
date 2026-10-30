export function separationDeviceLabel(requestedDevice: string, resolvedDevice: string | null): string | null {
  if (!resolvedDevice) return null;
  const resolved = resolvedDevice.toLowerCase();
  if (resolved === "cpu" && requestedDevice.toLowerCase() !== "cpu") return "CPU fallback";
  if (resolved === "dml") return "DirectML";
  if (resolved === "cuda") return "CUDA";
  if (resolved === "cpu") return "CPU";
  return resolvedDevice;
}

export function separationDeviceHint(requestedDevice: string, resolvedDevice: string | null): string | null {
  if (!resolvedDevice) return null;
  const resolved = resolvedDevice.toLowerCase();
  if (resolved === "cpu" && requestedDevice.toLowerCase() !== "cpu") {
    return "The requested accelerator was unavailable. This job completed on CPU and may take longer.";
  }
  if (resolved === "cpu") return "This job completed on CPU.";
  if (resolved === "dml") return "This job used the DirectML execution provider.";
  if (resolved === "cuda") return "This job used the CUDA execution provider.";
  return `This job completed with the ${resolvedDevice} execution provider.`;
}
