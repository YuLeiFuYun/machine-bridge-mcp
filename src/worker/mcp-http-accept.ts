export function acceptsEventStream(request: Pick<Request, "headers">): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.split(",").some((entry) => {
    const [mediaType, ...parameters] = entry.split(";").map((value) => value.trim().toLowerCase());
    if (mediaType !== "text/event-stream") return false;
    const quality = parameters.find((value) => value.startsWith("q="));
    if (!quality) return true;
    const parsed = Number(quality.slice(2));
    return Number.isFinite(parsed) && parsed > 0;
  });
}
