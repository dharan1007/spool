// Native file dialogs. Paths returned from the OS are the only way a user can
// point the Console at a file; every path is re-validated by the service layer
// against its containment policy before use.
import { dialog } from "electron";

const CSV_FILTER = [{ name: "UTF-8 CSV", extensions: ["csv"] }];
const SQLITE_FILTER = [{ name: "SQLite database", extensions: ["db", "sqlite", "sqlite3", "db3"] }];

export function createDialogService({ getWindow }) {
  async function chooseSourceCsv() {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: "Choose the UTF-8 CSV source file",
      properties: ["openFile"],
      filters: CSV_FILTER
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  }

  async function chooseSqliteDatabase() {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: "Choose the existing SQLite database",
      properties: ["openFile"],
      filters: SQLITE_FILTER
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  }

  async function chooseDirectory({ title } = {}) {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: title ?? "Choose a directory",
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  }

  return Object.freeze({ chooseSourceCsv, chooseSqliteDatabase, chooseDirectory });
}
