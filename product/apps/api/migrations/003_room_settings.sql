ALTER TABLE rooms ADD COLUMN IF NOT EXISTS duration_seconds integer NOT NULL DEFAULT 30 CHECK (duration_seconds IN (30, 60, 120, 300));
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS retell_style text NOT NULL DEFAULT 'auditory' CHECK (retell_style IN ('auditory', 'keywords'));
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS topic varchar(80) NOT NULL DEFAULT '家庭日常';
