import { createContext, useContext } from "react";

/** What the API says about itself: whether this host can run stages and show logs (the Worker can). */
export type Session = { worker: boolean };
export const SessionContext = createContext<Session>({ worker: false });
export const useSession = () => useContext(SessionContext);
