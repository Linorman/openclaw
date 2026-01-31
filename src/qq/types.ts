export type QQMessageEvent = {
  post_type: "message";
  message_type: "private" | "group";
  sub_type?: "friend" | "group" | "other" | "normal" | "anonymous";
  message_id: number;
  user_id: number;
  group_id?: number;
  message: string | QQMessageSegment[];
  raw_message: string;
  font?: number;
  sender: {
    user_id: number;
    nickname: string;
    card?: string;
    sex?: "male" | "female" | "unknown";
    age?: number;
    area?: string;
    level?: string;
    role?: "owner" | "admin" | "member";
    title?: string;
  };
  time: number;
  self_id: number;
};

export type QQMessageSegment =
  | { type: "text"; data: { text: string } }
  | { type: "image"; data: { file: string; url?: string; subType?: string } }
  | { type: "face"; data: { id: string } }
  | { type: "at"; data: { qq: string | number } }
  | { type: "reply"; data: { id: string } }
  | { type: "json"; data: { data: string } }
  | { type: "xml"; data: { data: string } }
  | { type: "record"; data: { file: string; url?: string } }
  | { type: "video"; data: { file: string; url?: string } }
  | { type: "file"; data: { file: string; url?: string } };

export type QQNoticeEvent =
  | {
      post_type: "notice";
      notice_type: "group_increase" | "group_decrease";
      group_id: number;
      user_id: number;
      operator_id?: number;
      sub_type?: string;
      time: number;
      self_id: number;
    }
  | {
      post_type: "notice";
      notice_type: "friend_add";
      user_id: number;
      time: number;
      self_id: number;
    }
  | {
      post_type: "notice";
      notice_type: "group_recall" | "friend_recall";
      group_id?: number;
      user_id: number;
      message_id: number;
      time: number;
      self_id: number;
    };

export type QQRequestEvent =
  | {
      post_type: "request";
      request_type: "friend";
      user_id: number;
      comment?: string;
      flag: string;
      time: number;
      self_id: number;
    }
  | {
      post_type: "request";
      request_type: "group";
      sub_type: "add" | "invite";
      group_id: number;
      user_id: number;
      comment?: string;
      flag: string;
      time: number;
      self_id: number;
    };

export type QQMetaEvent = {
  post_type: "meta_event";
  meta_event_type: "lifecycle" | "heartbeat";
  sub_type?: string;
  time: number;
  self_id: number;
  status?: {
    online: boolean;
    good: boolean;
  };
  interval?: number;
};

export type QQEvent = QQMessageEvent | QQNoticeEvent | QQRequestEvent | QQMetaEvent;

export type QQChatType = "direct" | "group";

export type QQInboundMessage = {
  channel: "qq";
  accountId: string;
  chatType: QQChatType;
  peerId: string;
  senderId: string;
  senderName: string;
  text: string;
  messageId: string;
  timestamp: number;
  replyToId?: string;
  groupId?: string;
  raw: QQMessageEvent;
};
