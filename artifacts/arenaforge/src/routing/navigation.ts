import { useLocation, useNavigate, useParams as routerParams } from "react-router-dom";

export const useParams = routerParams;
export function usePathname() { return useLocation().pathname; }
export function useSearchParams() { return new URLSearchParams(useLocation().search); }
export function useRouter() {
  const navigate = useNavigate();
  return {
    push: (url: string) => navigate(url),
    replace: (url: string) => navigate(url, { replace: true }),
    back: () => navigate(-1),
    forward: () => navigate(1),
    refresh: () => window.location.reload(),
    prefetch: () => {},
  };
}
