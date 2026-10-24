-- 0.4.0, fix round (UX4-15): the table sorts names in the order of the Serbian Latin
-- alphabet (c č ć d dž đ ... s š ... z ž), so that "Dragan" comes before "Đorđe". The ICU
-- collation sr-Latn ships with PostgreSQL built with ICU (the image of docker-compose.yml
-- and deploy/); a server without ICU stops this migration rather than sort another way.
-- Only the columns the fixed sort map orders by text: the title, the first author and the
-- institution. The search reads `search_text`, which keeps the default collation.
ALTER TABLE "submissions" ALTER COLUMN "title" TYPE TEXT COLLATE "sr-Latn-x-icu";
ALTER TABLE "submissions" ALTER COLUMN "first_author_name" TYPE TEXT COLLATE "sr-Latn-x-icu";
ALTER TABLE "submissions" ALTER COLUMN "first_author_institution" TYPE TEXT COLLATE "sr-Latn-x-icu";
