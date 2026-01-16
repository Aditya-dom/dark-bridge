#!/usr/bin/env bun
/**
 * Quick Relay CLI
 * 
 * Quickly relay a specific outgoing message.
 * Usage: EVM_PRIVATE_KEY=0x... bun run src/relay.ts <outgoing_message_pubkey>
 */

import { relayMessage } from './auto-relayer';

const pubkey = process.argv[2];
if (!pubkey) {
    console.log('Usage: bun run src/relay.ts <outgoing_message_pubkey>');
    process.exit(1);
}

console.log(`\n🚀 Relaying message: ${pubkey}\n`);
relayMessage(pubkey)
    .then(success => {
        if (success) {
            console.log('\n✅ Message processed successfully!');
        } else {
            console.log('\n⚠️ Message was already processed or failed');
        }
        process.exit(0);
    })
    .catch(err => {
        console.error('\n❌ Error:', err.message);
        process.exit(1);
    });
