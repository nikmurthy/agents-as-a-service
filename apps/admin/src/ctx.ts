import { useOutletContext } from "react-router-dom";

export interface BizCtx {
  id: string;
  business: { id: string; slug: string; name: string; status: string; pack: string };
  /** Owners and platform admins. Staff can look and decide on replies, nothing more. */
  canManage: boolean;
  isAdmin: boolean;
}
export const useBiz = () => useOutletContext<BizCtx>();
