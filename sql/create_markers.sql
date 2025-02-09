CREATE TABLE markers (
  [id] integer PRIMARY KEY AUTOINCREMENT,
  [createdOn] DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  [userId] char(20) NOT NULL,
  [username] varchar(32) NOT NULL,
  [epoch] int NOT NULL,
	[lat] double NOT NULL,
	[lng] double NOT NULL,
  [size] int NOT NULL
);

CREATE INDEX idx_markers_epoch ON markers(epoch);
