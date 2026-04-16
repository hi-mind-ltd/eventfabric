import { AggregateRoot, type HandlerMap } from "@eventfabric/core";
import type { UserEvent } from "./user.events";

export type UserState = { email?: string; displayName?: string };

export class UserAggregate extends AggregateRoot<UserState, UserEvent> {
  static readonly aggregateName = "User" as const;

  protected handlers = {
    UserRegistered: (s, e) => {
      s.email = e.email;
      s.displayName = e.displayName;
    },
    UserEmailChanged: (s, e) => {
      s.email = e.email;
    }
  } satisfies HandlerMap<UserEvent, UserState>;

  constructor(id: string, snapshot?: UserState) {
    super(id, snapshot ?? {});
  }

  register(email: string, displayName: string) {
    this.raise({ type: "UserRegistered", version: 2, userId: this.id, email, displayName });
  }

  changeEmail(email: string) {
    this.raise({ type: "UserEmailChanged", version: 1, userId: this.id, email });
  }
}
