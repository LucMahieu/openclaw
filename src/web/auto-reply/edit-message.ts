import type { AnyMessageContent } from "@whiskeysockets/baileys";

export async function editWhatsAppMessage(params: {
  jid: string;
  messageId: string;
  newText: string;
  sock: {
    sendMessage: (jid: string, content: AnyMessageContent) => Promise<unknown>;
  };
}): Promise<void> {
  await params.sock.sendMessage(params.jid, {
    text: params.newText,
    edit: {
      id: params.messageId,
      remoteJid: params.jid,
      fromMe: true,
    },
  } as AnyMessageContent);
}
