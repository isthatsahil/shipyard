# Builds shipyard/builder:node20, :node22 and :node24 from the one Dockerfile.
#   docker buildx bake -f docker/builder/docker-bake.hcl --load           # all
#   docker buildx bake -f docker/builder/docker-bake.hcl --load node22    # one
group "default" { targets = ["builder"] }

target "builder" {
  name       = "node${v}"
  matrix     = { v = ["20", "22", "24"] }
  context    = "docker/builder"
  dockerfile = "Dockerfile"
  args       = { NODE_MAJOR = v }
  tags       = ["shipyard/builder:node${v}"]
}
