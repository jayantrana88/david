import type { ComponentProps } from "react";
import { Link as RouterLink } from "react-router-dom";

/** An in-app link that takes `href` (like the anchor it replaces) and navigates without a reload. */
export default function Link({ href, ...props }: Omit<ComponentProps<typeof RouterLink>, "to"> & { href: string }) {
  return <RouterLink to={href} {...props} />;
}
