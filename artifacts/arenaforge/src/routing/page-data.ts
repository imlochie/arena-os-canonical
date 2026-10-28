import { useEffect, useState } from "react";

export function usePageData<T = any>(kind: string, id: string) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: T }>({
    loading: true, error: null, data: null as T,
  });
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, error: null, data: null as T });
    fetch(`/api/page-data/${kind}/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(async res => {
        const data = JSON.parse(await res.text(), (key, value) =>
          /(?:createdAt|updatedAt)$/.test(key) && typeof value === "string" ? new Date(value) : value);
        if (!res.ok) throw new Error(data.error || "Could not load this page");
        setState({ loading: false, error: null, data: data as T });
      })
      .catch(error => {
        if (error.name !== "AbortError") setState({ loading: false, error: error.message, data: null as T });
      });
    return () => controller.abort();
  }, [kind, id]);
  return state;
}
