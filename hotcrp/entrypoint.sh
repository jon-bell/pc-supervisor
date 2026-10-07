#!/usr/bin/env bash
# Writes conf/options.php from env, loads the schema into an empty DB,
# then hands off to Apache.
set -euo pipefail
cd /var/www/html

: "${HOTCRP_DB_HOST:=db}" "${HOTCRP_DB_NAME:=hotcrp}" "${HOTCRP_DB_USER:=hotcrp}"
: "${HOTCRP_DB_PASSWORD:=hotcrp}" "${HOTCRP_SITE_URL:=http://localhost:8080}"
: "${HOTCRP_SHORT_NAME:=PCS-Test}" "${HOTCRP_LONG_NAME:=PC Supervisor Test Conference}"

cat > conf/options.php <<PHP
<?php
\$Opt["dbName"] = "${HOTCRP_DB_NAME}";
\$Opt["dbUser"] = "${HOTCRP_DB_USER}";
\$Opt["dbPassword"] = "${HOTCRP_DB_PASSWORD}";
\$Opt["dbHost"] = "${HOTCRP_DB_HOST}";
\$Opt["shortName"] = "${HOTCRP_SHORT_NAME}";
\$Opt["longName"] = "${HOTCRP_LONG_NAME}";
\$Opt["paperSite"] = "${HOTCRP_SITE_URL}";
\$Opt["sendEmail"] = false;
\$Opt["emailFrom"] = "noreply@example.org";
\$Opt["docstore"] = "/var/www/html/filestore";
\$Opt["contactName"] = "Test Admin";
\$Opt["contactEmail"] = "admin@example.org";
PHP

mysql_cmd=(mysql --skip-ssl -h "$HOTCRP_DB_HOST" -u "$HOTCRP_DB_USER" "-p$HOTCRP_DB_PASSWORD" "$HOTCRP_DB_NAME")
for i in $(seq 1 60); do
    "${mysql_cmd[@]}" -e "select 1" >/dev/null 2>&1 && break
    [ "$i" = 60 ] && { echo "hotcrp: database not reachable" >&2; exit 1; }
    sleep 1
done
if ! "${mysql_cmd[@]}" -e "select 1 from Settings limit 1" >/dev/null 2>&1; then
    echo "hotcrp: loading schema"
    "${mysql_cmd[@]}" < src/schema.sql
fi

exec "$@"
