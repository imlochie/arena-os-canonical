import { useEffect, useState } from "react";

export function usePageData(kind: string, id: string) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: any }>({
    loading: true, error: null, data: null,
  });
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, error: null, data: null });
    fetch(`/api/page-data/${kind}/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(async res => {
        const data = JSON.parse(await res.text(), (key, value) =>
          /(?:createdAt|updatedAt)$/.test(key) && typeof value === "string" ? new Date(value) : value);
        if (!res.ok) throw new Error(data.error || "Could not load this page");
        setState({ loading: false, error: null, data });
      })
      .catch(error => {
        if (error.name !== "AbortError") setState({ loading: false, error: error.message, data: null });
      });
    return () => controller.abort();
  }, [kind, id]);
  return state;
}
