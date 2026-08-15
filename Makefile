.PHONY: mcp-auth-proxy mcp-auth-proxy-test mcp-auth-proxy-image mcp-auth-proxy-buildx

mcp-auth-proxy:
	$(MAKE) -C mcp-auth-proxy build

mcp-auth-proxy-test:
	$(MAKE) -C mcp-auth-proxy test

mcp-auth-proxy-image:
	$(MAKE) -C mcp-auth-proxy image


mcp-auth-proxy-buildx:
	./build-mcp-auth-proxy.sh
