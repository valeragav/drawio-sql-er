-- SQLite — для проверки плагина.
CREATE TABLE IF NOT EXISTS [authors] (
  [id] INTEGER PRIMARY KEY AUTOINCREMENT,
  [name] TEXT NOT NULL,
  country TEXT DEFAULT 'RU'
);

CREATE TABLE books (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL,
  title TEXT NOT NULL COLLATE NOCASE,
  year INTEGER CHECK (year > 0),
  FOREIGN KEY(author_id) REFERENCES authors(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_books_author ON books(author_id);
