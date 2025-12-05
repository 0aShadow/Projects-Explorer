import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const STATE_KEY = 'projectsExplorer.categoryMap';

// Default message used as key for the undefined category label.
const UNDEFINED_CAT_MESSAGE = vscode.l10n.t('Uncategorized');
function getUndefinedCategoryLabel(): string {
  return vscode.l10n.t(UNDEFINED_CAT_MESSAGE);
}

type CategoryQuickPickItem = vscode.QuickPickItem & {
  isCreate?: boolean;
};

export function activate(context: vscode.ExtensionContext) {
  const provider = new ProjectsProvider(context);
  const dnd = new ProjectsDragAndDropController(provider);

  const treeView = vscode.window.createTreeView('projectsExplorer', {
    treeDataProvider: provider,
    showCollapseAll: true,
    dragAndDropController: dnd
  });
  context.subscriptions.push(treeView, dnd);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'projectsExplorer.refresh',
      () => provider.refresh()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'projectsExplorer.openProject',
      (item?: ProjectItem) => openProject(item, false)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'projectsExplorer.openProjectInNewWindow',
      (item?: ProjectItem) => openProject(item, true)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'projectsExplorer.addProjectToWorkspace',
      (item?: ProjectItem) => addToWorkspace(item)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'projectsExplorer.moveToCategory',
      async (item?: ProjectItem) => {
        if (!item) return;
        await provider.moveProjectToCategory(item.folderPath);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'projectsExplorer.toggleOpenInNewWindow',
      async () => {
        const cfg = vscode.workspace.getConfiguration('projectsExplorer');
        const current = cfg.get<boolean>('openInNewWindowByDefault', true);
        await cfg.update(
          'openInNewWindowByDefault',
          !current,
          vscode.ConfigurationTarget.Global
        );
        vscode.window.showInformationMessage(
          current
            ? vscode.l10n.t('Open in New Window by Default: OFF')
            : vscode.l10n.t('Open in New Window by Default: ON')
        );
        provider.refresh();
      }
    )
  );

  // React to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('projectsExplorer.openInNewWindowByDefault') ||
        e.affectsConfiguration('projectsExplorer.rootPath') ||
        e.affectsConfiguration('projectsExplorer.rootPaths') ||
        e.affectsConfiguration('projectsExplorer.requireGit') ||
        e.affectsConfiguration('projectsExplorer.ignore')
      ) {
        provider.refresh();
      }
    })
  );
}

export function deactivate() {}


/* -------------------------------------------------------------------------- */
/*                             Tree Data Provider                             */
/* -------------------------------------------------------------------------- */

class ProjectsProvider
  implements vscode.TreeDataProvider<CategoryItem | ProjectItem>
{
  private _onDidChangeTreeData =
    new vscode.EventEmitter<CategoryItem | ProjectItem | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly ctx: vscode.ExtensionContext | undefined) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CategoryItem | ProjectItem): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: CategoryItem | ProjectItem
  ): Promise<(CategoryItem | ProjectItem)[]> {
    const config = vscode.workspace.getConfiguration('projectsExplorer');

    // Use multiple root paths (fallback to legacy rootPath)
    const rootPaths = (config.get<string[]>('rootPaths') || []).filter(Boolean);
    const legacyRoot = config.get<string>('rootPath') || '';
    if (rootPaths.length === 0 && legacyRoot) {
      rootPaths.push(legacyRoot);
    }

    const requireGit = config.get<boolean>('requireGit') || false;
    const ignore = config.get<string[]>('ignore') || [];

    if (rootPaths.length === 0) {
      if (!element) {
        vscode.window.showInformationMessage(
          vscode.l10n.t(
            'Set "projectsExplorer.rootPaths" (or legacy "rootPath") to at least one existing folder.'
          )
        );
      }
      return [];
    }

    // Collect all projects across root paths
    type Project = { name: string; full: string; root: string };
    const projects: Project[] = [];

    for (const rp of rootPaths) {
      if (!rp || !fs.existsSync(rp)) continue;

      try {
        const entries: fs.Dirent[] = await fs.promises.readdir(rp, {
          withFileTypes: true
        });

        const dirs = entries.filter(
          e => e.isDirectory() && !ignore.includes(e.name)
        );

        for (const d of dirs) {
          const full = path.join(rp, d.name);
          if (requireGit && !fs.existsSync(path.join(full, '.git'))) continue;
          projects.push({ name: d.name, full, root: rp });
        }
      } catch {
        // Ignore inaccessible directories
      }
    }

    // De-duplicate by full path
    const uniqMap = new Map<string, Project>();
    for (const p of projects) uniqMap.set(p.full, p);
    const uniqProjects = Array.from(uniqMap.values());

    const map =
      this.ctx?.globalState.get<Record<string, string>>(STATE_KEY, {}) || {};

    // Root level → return categories
    if (!element) {
      const grouped = new Map<string, number>();

      for (const p of uniqProjects) {
        const cat = map[p.full] || getUndefinedCategoryLabel();
        grouped.set(cat, (grouped.get(cat) || 0) + 1);
      }

      const cats = Array.from(grouped.keys()).sort((a, b) =>
        a.localeCompare(b)
      );

      return cats.map(
        c => new CategoryItem(c, grouped.get(c) ?? 0)
      );
    }

    // Category level → return projects inside that category
    if (element instanceof CategoryItem) {
      const inCat = uniqProjects
        .filter(
          p =>
            (map[p.full] || getUndefinedCategoryLabel()) === element.label
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(p => new ProjectItem(p.name, p.full));

      return inCat;
    }

    // Project items have no children
    return [];
  }

  async moveProjectToCategory(
    folderPath: string,
    targetCategory?: string
  ): Promise<void> {
    if (!this.ctx) return;

    const map =
      this.ctx.globalState.get<Record<string, string>>(STATE_KEY, {}) || {};
    const current = map[folderPath] || getUndefinedCategoryLabel();

    // Existing categories
    const existingCats = new Set<string>(Object.values(map).filter(Boolean));
    existingCats.add(getUndefinedCategoryLabel());

    let category = targetCategory;

    // If no category passed → ask user
    if (!category) {
      const picks: CategoryQuickPickItem[] = [];

      for (const c of existingCats) {
        picks.push({
          label: c,
          description:
            c === current ? vscode.l10n.t('current') : undefined,
          isCreate: false
        });
      }

      picks.push({
        label: `$(add) ${vscode.l10n.t('Create new category…')}`,
        description: vscode.l10n.t('Create a new category'),
        alwaysShow: true,
        isCreate: true
      });

      const pick = await vscode.window.showQuickPick<CategoryQuickPickItem>(
        picks,
        { placeHolder: vscode.l10n.t('Choose category') }
      );

      if (!pick) return;

      if (pick.isCreate) {
        const input = await vscode.window.showInputBox({
          prompt: vscode.l10n.t('New category:'),
          validateInput: v =>
            v.trim() ? undefined : vscode.l10n.t('Please enter a name')
        });

        if (!input) return;
        category = input;
      } else {
        category = pick.label;
      }
    }

    if (!category) return;

    // No category is represented by missing map entry, not by a special string
    if (category === getUndefinedCategoryLabel()) {
      delete map[folderPath];
    } else {
      map[folderPath] = category;
    }

    await this.ctx.globalState.update(STATE_KEY, map);
    this.refresh();
  }
}


/* -------------------------------------------------------------------------- */
/*                             Drag & Drop Logic                               */
/* -------------------------------------------------------------------------- */

class ProjectsDragAndDropController
  implements vscode.TreeDragAndDropController<CategoryItem | ProjectItem>
{
  readonly dragMimeTypes = ['application/vnd.code.tree.projectsExplorer'];
  readonly dropMimeTypes = ['application/vnd.code.tree.projectsExplorer'];

  constructor(private readonly provider: ProjectsProvider) {}

  async handleDrag(
    source: readonly (CategoryItem | ProjectItem)[],
    data: vscode.DataTransfer
  ): Promise<void> {
    const projects = source.filter(
      (s): s is ProjectItem => s instanceof ProjectItem
    );

    if (!projects.length) return;

    const payload = projects.map(p => p.folderPath);
    data.set(
      this.dragMimeTypes[0],
      new vscode.DataTransferItem(JSON.stringify(payload))
    );
  }

  async handleDrop(
    target: CategoryItem | ProjectItem | undefined,
    data: vscode.DataTransfer
  ): Promise<void> {
    const item = data.get(this.dragMimeTypes[0]);
    if (!item) return;

    let folderPaths: string[];
    try {
      folderPaths = JSON.parse(await item.asString());
    } catch {
      return;
    }

    if (!target || !(target instanceof CategoryItem)) return;

    const categoryName = target.label?.toString();
    if (!categoryName) return;

    for (const fp of folderPaths) {
      await this.provider.moveProjectToCategory(fp, categoryName);
    }
  }

  dispose(): void {}
}


/* -------------------------------------------------------------------------- */
/*                                 Tree Items                                 */
/* -------------------------------------------------------------------------- */

class CategoryItem extends vscode.TreeItem {
  constructor(label: string, count: number) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.label = label;
    this.description = count.toString();
    this.contextValue = 'category';
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

class ProjectItem extends vscode.TreeItem {
  constructor(public readonly label: string, public readonly folderPath: string) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.description = folderPath;
    this.tooltip = folderPath;
    this.contextValue = 'project';

    const config = vscode.workspace.getConfiguration('projectsExplorer');
    const openInNewWindow = config.get<boolean>(
      'openInNewWindowByDefault',
      true
    );

    this.command = {
      title: openInNewWindow
        ? vscode.l10n.t('Open Project in New Window')
        : vscode.l10n.t('Open Project'),
      command: openInNewWindow
        ? 'projectsExplorer.openProjectInNewWindow'
        : 'projectsExplorer.openProject',
      arguments: [this]
    };

    this.iconPath = new vscode.ThemeIcon('root-folder');
  }
}


/* -------------------------------------------------------------------------- */
/*                              Command Helpers                               */
/* -------------------------------------------------------------------------- */

async function openProject(
  item: ProjectItem | undefined,
  newWindow: boolean
): Promise<void> {
  if (!item) {
    const selected = await pickProjectQuickPick();
    if (!selected) return;
    item = selected;
  }

  await vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(item.folderPath),
    newWindow
  );
}

async function addToWorkspace(item?: ProjectItem): Promise<void> {
  if (!item) {
    const selected = await pickProjectQuickPick();
    if (!selected) return;
    item = selected;
  }

  const uri = vscode.Uri.file(item.folderPath);
  const index = vscode.workspace.workspaceFolders?.length ?? 0;

  vscode.workspace.updateWorkspaceFolders(index, null, {
    uri,
    name: item.label
  });
}

async function pickProjectQuickPick(): Promise<ProjectItem | undefined> {
  const provider = new ProjectsProvider(undefined);
  const cats = await provider.getChildren();
  const projects: ProjectItem[] = [];

  for (const c of cats) {
    if (c instanceof CategoryItem) {
      const children = await provider.getChildren(c);
      for (const p of children) {
        if (p instanceof ProjectItem) projects.push(p);
      }
    }
  }

  const pick = await vscode.window.showQuickPick(
    projects.map(i => ({
      label: i.label,
      description: i.folderPath,
      item: i
    })),
    { placeHolder: vscode.l10n.t('Select project') }
  );

  return pick?.item;
}
