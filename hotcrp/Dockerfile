# Disposable HotCRP for development, CI, and scale tests. NOT for real review data.
FROM php:8.3-apache

RUN apt-get update \
 && apt-get install -y --no-install-recommends libicu-dev libzip-dev mariadb-client poppler-utils \
 && docker-php-ext-install mysqli intl zip \
 && a2enmod rewrite setenvif \
 && printf 'SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1\n' > /etc/apache2/conf-enabled/hotcrp-auth.conf \
 && sed -ri 's!AllowOverride None!AllowOverride All!g' /etc/apache2/apache2.conf \
 && rm -rf /var/lib/apt/lists/*

# Pin HotCRP to an exact commit so CI is reproducible. Bump deliberately
# (and re-run the API contract tests) when hotcrp.com moves.
ARG HOTCRP_REF=60f693f88b9a0ef9e34b11af957a513f1c122690
WORKDIR /var/www/html
RUN curl -fsSL "https://codeload.github.com/kohler/hotcrp/tar.gz/${HOTCRP_REF}" \
      | tar xz --strip-components=1 -C /var/www/html \
 && mkdir -p filestore && chown -R www-data filestore

COPY entrypoint.sh /usr/local/bin/hotcrp-entrypoint
ENTRYPOINT ["hotcrp-entrypoint"]
CMD ["apache2-foreground"]
