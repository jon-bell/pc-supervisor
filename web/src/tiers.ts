// Whether PCS_TIER_TAGS defines any tier (/api/meta `tiersConfigured`). When
// it doesn't, everyone is "senior" and the UI shows no tier fields, columns,
// chips, filters, or the tier-progress view. App.tsx provides the value;
// components deep in a view read it with useTiersConfigured().

import { createContext, useContext } from "react";

export const TiersContext = createContext(true);

export const useTiersConfigured = () => useContext(TiersContext);
