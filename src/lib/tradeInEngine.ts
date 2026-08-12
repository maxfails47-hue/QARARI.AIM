
export interface DevicePriceMap {
  tradeIn: number;      // Price in shops (lowest, fastest)
  directSale: number;   // Price on OLX/Dubizzle (average)
  socialGroups: number; // Price on FB Groups (highest, most effort)
  marketStatus: "hot" | "stable" | "dropping";
  demandLevel: number; // 1-10
}

export const deviceMarketData: Record<string, { basePrice: number, retention: number }> = {
  "iphone 15 pro max": { basePrice: 65000, retention: 0.90 },
  "iphone 15 pro": { basePrice: 55000, retention: 0.88 },
  "iphone 15": { basePrice: 40000, retention: 0.85 },
  "iphone 14 pro max": { basePrice: 50000, retention: 0.82 },
  "iphone 13": { basePrice: 28000, retention: 0.78 },
  "samsung s24 ultra": { basePrice: 55000, retention: 0.75 },
  "samsung s23 ultra": { basePrice: 42000, retention: 0.70 },
  "macbook pro m3": { basePrice: 85000, retention: 0.92 },
  "macbook air m2": { basePrice: 45000, retention: 0.88 },
  "msi pulse gl66": { basePrice: 45000, retention: 0.65 },
  "ps5": { basePrice: 28000, retention: 0.85 },
};

export function getSmartMarketPrice(deviceName: string, condition: string): DevicePriceMap {
  const name = deviceName.toLowerCase();
  let base = 30000; // Default fallback
  let retention = 0.60;

  // Find closest match in data
  for (const [key, data] of Object.entries(deviceMarketData)) {
    if (name.includes(key)) {
      base = data.basePrice;
      retention = data.retention;
      break;
    }
  }

  // Adjust for condition
  const conditionMult: Record<string, number> = {
    excellent: 1.0,
    good: 0.88,
    fair: 0.75,
    poor: 0.55,
  };
  
  const currentMarketValue = base * (conditionMult[condition] || 0.8);
  
  // Calculate the three tiers
  const directSale = Math.round(currentMarketValue);
  const tradeIn = Math.round(directSale * 0.82); // Shops take ~18% margin
  const socialGroups = Math.round(directSale * 1.07); // FB groups can get ~7% more

  // Determine market status
  let status: "hot" | "stable" | "dropping" = "stable";
  if (name.includes("iphone") || name.includes("macbook")) status = "hot";
  if (name.includes("12") || name.includes("11") || name.includes("2021")) status = "dropping";

  return {
    tradeIn,
    directSale,
    socialGroups,
    marketStatus: status,
    demandLevel: status === "hot" ? 9 : status === "stable" ? 6 : 4,
  };
}
