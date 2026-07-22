import { defineExtensionMessaging } from '@webext-core/messaging';
import type { ExtensionProtocolMap } from '@ui-agent/contracts';

export const { sendMessage, onMessage } = defineExtensionMessaging<ExtensionProtocolMap>();
