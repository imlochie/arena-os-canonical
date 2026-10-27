import { forwardRef, type AnchorHTMLAttributes } from "react";
import { Link as RouterLink } from "react-router-dom";

/** Keep the original anchor markup while using client-side route navigation. */
export default forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(
  function Link({ href = "/", children, ...props }, ref) {
    if (/^(https?:|mailto:|tel:|#)/.test(href) || props.target === "_blank" || props.download) {
      return <a ref={ref} href={href} {...props}>{children}</a>;
    }
    return <RouterLink ref={ref} to={href} {...props}>{children}</RouterLink>;
  },
);
