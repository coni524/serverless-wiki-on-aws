/** The four administration screens. See `common.ts` for the shape. */

/**
 * The three levels a role group can hold on a space, weakest first. Named here
 * rather than imported from `lib` so the dictionary stays free of the screen's
 * own types; `RoleGroups.tsx` holds the list the picker walks.
 */
type GrantLevel = 'read' | 'write' | 'admin';

export const ja = {
  // ─── The shell around the four screens ─────────────────────────────────────

  /** Section names, keyed by the segment the route carries (`router.tsx`). */
  sections: {
    users: '利用者',
    'user-groups': 'ユーザーグループ',
    'role-groups': 'ロールグループ',
    defaults: '既定の設定',
  },
  breadcrumbsLabel: 'パンくずリスト',
  spacesCrumb: 'スペース一覧',
  notGlobalAdmin: 'この画面はグローバル管理者だけが使える。権限が要るなら、管理者に依頼する。',

  // ─── Words more than one of the four screens uses ──────────────────────────
  shared: {
    reload: '再読み込み',
    name: '名前',
    description: '説明',
    /** The hint under the description field: filling it in is not required. */
    optional: '任意',
    email: 'メールアドレス',
    loadMore: 'さらに読み込む',
    globalBadge: 'グローバル管理者',
    systemBadge: 'システム',
    deleteHeader: (name: string): string => `「${name}」を削除`,
    filterByEmail: 'メールアドレスの先頭で絞り込む',
    loadingUsers: '利用者を読み込み中…',
  },

  // ─── The account directory ─────────────────────────────────────────────────
  users: {
    description:
      'Wiki に一度でもサインインしたアカウント。Cognito のアカウントそのものは AWS 側で管理する。',
    userId: '利用者 ID',
    empty: 'サインインしたアカウントがまだありません。',
    emptyFiltered: (prefix: string): string => `「${prefix}」で始まるアドレスは見つかりませんでした。`,
    grantingHeader: '権限の与え方',
    grantingBody:
      '利用者に直接権限を与える経路はない。利用者をユーザーグループに入れ、そのユーザーグループにロールグループを付け、ロールグループにスペースの権限を与える、という 3 段でつなぐ。所属の変更は「ユーザーグループ」の画面で行う。',
  },

  // ─── User groups ───────────────────────────────────────────────────────────
  userGroups: {
    listDescription: '利用者をまとめる単位。ロールグループを付けることで権限が届く。',
    loading: 'ユーザーグループを読み込み中…',
    empty: 'ユーザーグループがありません。',
    createHeader: 'ユーザーグループを作成',
    nameLabel: 'グループ名',
    notFound: 'このユーザーグループは見つかりませんでした。削除された可能性がある。',
    deleteBody:
      'このグループの所属とロールグループの付け外しも一緒に消える。所属していた利用者は、このグループ経由で届いていた権限を失う。',
    deleteDetailBody: (members: number): string =>
      `所属している ${members} 人は、このグループ経由で届いていた権限を失う。`,

    membersHeader: 'メンバー',
    membersDescription: 'このグループに所属する利用者。',
    membersEmpty: 'メンバーがいません。',
    addMember: '利用者を追加',
    alreadyMember: '所属済み',
    directoryEmpty: '該当する利用者がいない。追加できるのは一度サインインしたアカウントだけである。',
    remove: '外す',

    roleGroupsDescription:
      'このグループの利用者に届くロールグループ。スペースへの権限はロールグループが持つ。',
    roleGroupsEmpty: 'ロールグループが付いていない。このままではメンバーはどのスペースにも届かない。',
    attachHeader: 'ロールグループを付ける',
    attach: '付ける',
    attachEmpty: '付けられるロールグループがない。',
  },

  // ─── Role groups ───────────────────────────────────────────────────────────
  roleGroups: {
    listDescription: 'スペースへの権限を持つ単位。ユーザーグループに付けて利用者へ届ける。',
    loading: 'ロールグループを読み込み中…',
    empty: 'ロールグループがありません。',
    createHeader: 'ロールグループを作成',
    nameLabel: 'ロールグループ名',
    notFound: 'このロールグループは見つかりませんでした。削除された可能性がある。',
    deleteBody:
      'スペースへの権限と、ユーザーグループへの付け外しも一緒に消える。このロールグループ経由で届いていた権限は、すべて失われる。',
    deleteDetailBody: (grants: number, userGroups: number): string =>
      `${grants} 件のスペース権限と、${userGroups} 件のユーザーグループへの付け外しが一緒に消える。`,
    globalNote:
      'このロールグループはグローバル管理者である。個別のスペース権限にかかわらず、すべてのスペースに admin として届き、管理操作もできる。',

    /** What each level lets its holder do, read out under the picker's rows. */
    level: (level: GrantLevel): string =>
      level === 'read'
        ? 'ページと添付を読める'
        : level === 'write'
          ? 'read に加えてページを作成・更新・削除できる'
          : 'write に加えてスペースの名前と説明を変えられる',

    grantsHeader: 'スペース権限',
    grantsDescription:
      'このロールグループが与えるスペースと権限。強さは read < write < admin の順で、複数の経路から届いたときは強いほうを採る。',
    grantsEmpty: '権限を持っていない。このロールグループを付けても、どのスペースにも届かない。',
    addSpace: 'スペースを追加',
    space: 'スペース',
    spacePlaceholder: 'スペースを選ぶ',
    spaceEmpty: '権限を与えていないスペースがない',
    permission: '権限',
    permissionFor: (space: string): string => `${space} の権限`,
    revoke: '剥奪',

    attachedHeader: '届く先のユーザーグループ',
    attachedDescription:
      'このロールグループが付いているユーザーグループ。付け外しはユーザーグループの画面で行う。',
    attachedEmpty: 'どのユーザーグループにも付いていない。誰にも届いていない。',
  },

  // ─── The default user group ────────────────────────────────────────────────
  defaults: {
    loading: '既定の設定を読み込み中…',
    header: '既定のユーザーグループ',
    description: '新しくサインインしたアカウントが自動的に入るユーザーグループ。',
    fieldLabel: 'ユーザーグループ',
    fieldDescription: '設定しないままなら、新しいアカウントはどのスペースにも届かない。',
    note: 'この設定は遡らない。すでにサインインしたことのあるアカウントは、ここを変えても自動では入らない。「ユーザーグループ」の画面から追加する。グローバル管理者になるユーザーグループは選べない（サインインしただけで Wiki 全体の管理者になってしまうため）。',
  },
};

export type Admin = typeof ja;

export const en: Admin = {
  sections: {
    users: 'Users',
    'user-groups': 'User groups',
    'role-groups': 'Role groups',
    defaults: 'Defaults',
  },
  breadcrumbsLabel: 'Breadcrumbs',
  spacesCrumb: 'Spaces',
  notGlobalAdmin:
    'Only a global administrator can use this screen. Ask an administrator if you need access.',

  shared: {
    reload: 'Reload',
    name: 'Name',
    description: 'Description',
    optional: 'Optional',
    email: 'Email address',
    loadMore: 'Load more',
    globalBadge: 'Global administrator',
    systemBadge: 'System',
    deleteHeader: (name: string): string => `Delete "${name}"`,
    filterByEmail: 'Filter by the start of the email address',
    loadingUsers: 'Loading users…',
  },

  users: {
    description:
      'Accounts that have signed in to the Wiki at least once. The Cognito accounts themselves are managed on the AWS side.',
    userId: 'User ID',
    empty: 'No account has signed in yet.',
    emptyFiltered: (prefix: string): string => `No address starting with "${prefix}" was found.`,
    grantingHeader: 'How permissions are granted',
    grantingBody:
      'There is no way to grant permission to a user directly. Put the user in a user group, attach a role group to that user group, and grant space permissions to the role group — three hops. Memberships are edited on the "User groups" screen.',
  },

  userGroups: {
    listDescription:
      'The unit that gathers users. Permissions reach them through the role groups attached to it.',
    loading: 'Loading user groups…',
    empty: 'No user groups.',
    createHeader: 'Create a user group',
    nameLabel: 'Group name',
    notFound: 'This user group was not found. It may have been deleted.',
    deleteBody:
      'Its memberships and its role group attachments go with it. The users in it lose the permissions that reached them through this group.',
    deleteDetailBody: (members: number): string =>
      members === 1
        ? 'The 1 member of this group loses the permissions that reached them through it.'
        : `The ${members} members of this group lose the permissions that reached them through it.`,

    membersHeader: 'Members',
    membersDescription: 'The users in this group.',
    membersEmpty: 'No members.',
    addMember: 'Add a user',
    alreadyMember: 'Already a member',
    directoryEmpty:
      'No matching user. Only an account that has signed in at least once can be added.',
    remove: 'Remove',

    roleGroupsDescription:
      'The role groups that reach the users in this group. Space permissions are held by the role group.',
    roleGroupsEmpty: 'No role group is attached. As it stands, the members reach no space.',
    attachHeader: 'Attach a role group',
    attach: 'Attach',
    attachEmpty: 'No role group left to attach.',
  },

  roleGroups: {
    listDescription:
      'The unit that holds space permissions. Attach it to a user group to deliver them to users.',
    loading: 'Loading role groups…',
    empty: 'No role groups.',
    createHeader: 'Create a role group',
    nameLabel: 'Role group name',
    notFound: 'This role group was not found. It may have been deleted.',
    deleteBody:
      'Its space permissions and its attachments to user groups go with it. Every permission that reached anyone through this role group is lost.',
    deleteDetailBody: (grants: number, userGroups: number): string =>
      `${grants} space permission${grants === 1 ? '' : 's'} and ${userGroups} user group attachment${
        userGroups === 1 ? '' : 's'
      } go with it.`,
    globalNote:
      'This role group is a global administrator. Whatever the individual space permissions say, it reaches every space as admin and can perform management operations.',

    level: (level: GrantLevel): string =>
      level === 'read'
        ? 'Read pages and attachments'
        : level === 'write'
          ? 'Everything in read, plus creating, updating and deleting pages'
          : 'Everything in write, plus changing a space name and description',

    grantsHeader: 'Space permissions',
    grantsDescription:
      'The spaces this role group grants, and the level on each. Strength runs read < write < admin, and the strongest wins when a space is reached by more than one path.',
    grantsEmpty: 'No permission held. Attaching this role group reaches no space.',
    addSpace: 'Add a space',
    space: 'Space',
    spacePlaceholder: 'Choose a space',
    spaceEmpty: 'No space is left without a permission',
    permission: 'Permission',
    permissionFor: (space: string): string => `Permission on ${space}`,
    revoke: 'Revoke',

    attachedHeader: 'User groups reached',
    attachedDescription:
      'The user groups this role group is attached to. Attach and detach on the user group screen.',
    attachedEmpty: 'Not attached to any user group. It reaches nobody.',
  },

  defaults: {
    loading: 'Loading defaults…',
    header: 'Default user group',
    description: 'The user group a newly signed-in account joins automatically.',
    fieldLabel: 'User group',
    fieldDescription: 'Left unset, a new account reaches no space.',
    note: 'This setting is not retroactive. An account that has already signed in does not join when this changes; add it from the "User groups" screen. A user group that confers global administrator cannot be chosen (signing in alone would make someone an administrator of the whole Wiki).',
  },
};
