ALTER TABLE notes
    ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '' CHECK (char_length(title) <= 120),
    ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT 'yellow' CHECK (color IN ('yellow', 'pink', 'blue', 'green', 'purple', 'orange')),
    ADD COLUMN IF NOT EXISTS pos_x INTEGER CHECK (pos_x BETWEEN 0 AND 100000),
    ADD COLUMN IF NOT EXISTS pos_y INTEGER CHECK (pos_y BETWEEN 0 AND 100000),
    ADD COLUMN IF NOT EXISTS z_index INTEGER NOT NULL DEFAULT 0 CHECK (z_index >= 0);
