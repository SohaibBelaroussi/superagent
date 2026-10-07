-- Every table's row count, by schema and name: what a backup holds, and what its restore must hold.
-- Traces' rows are left out of dumps (they are pruned anyway), so their table is counted as empty.
select table_schema || '.' || table_name || '|' ||
       case
         when table_schema = 'mastra' and table_name = 'mastra_ai_spans' then '0'
         else (xpath('/row/c/text()',
                     query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name),
                                  false, true, '')))[1]::text
       end
from information_schema.tables
where table_schema in ('app', 'mastra', 'drizzle', 'public') and table_type = 'BASE TABLE'
order by table_schema, table_name;
