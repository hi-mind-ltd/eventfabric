export type UserRegisteredV2 = {
  type: "UserRegistered";
  version: 2;
  userId: string;
  email: string;
  displayName: string;
};

export type UserEmailChangedV1 = {
  type: "UserEmailChanged";
  version: 1;
  userId: string;
  email: string;
};

export type UserEvent = UserRegisteredV2 | UserEmailChangedV1;

// Factory functions — type and version are baked in
export const UserRegistered = (data: Omit<UserRegisteredV2, "type" | "version">): UserRegisteredV2 =>
  ({ type: "UserRegistered", version: 2, ...data });

export const UserEmailChanged = (data: Omit<UserEmailChangedV1, "type" | "version">): UserEmailChangedV1 =>
  ({ type: "UserEmailChanged", version: 1, ...data });
