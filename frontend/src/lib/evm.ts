import { http, createConfig } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { injected, coinbaseWallet } from "wagmi/connectors";

export const wagmiConfig = createConfig({
    chains: [baseSepolia],
    connectors: [
        injected(),
        coinbaseWallet({ appName: "Privacy Bridge" }),
    ],
    transports: {
        [baseSepolia.id]: http("https://sepolia.base.org"),
    },
});
