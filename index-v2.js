Element.prototype.remove = function() {
    this.parentElement.removeChild(this);
}
NodeList.prototype.remove = HTMLCollection.prototype.remove = function() {
    for (var i = this.length - 1; i >= 0; i--) {
        if (this[i] && this[i].parentElement) {
            this[i].parentElement.removeChild(this[i]);
        }
    }
}

var pattern = Trianglify({
    width: window.innerWidth,
    height: window.innerHeight,
    x_colors: "random"
});
document.body.appendChild(pattern.canvas())

$(".content").hover(
    function() {
        $('#tag').fadeOut(200, function() {
            $(this).text("Student, Developer, Currently Rocking it at Brown University").fadeIn(200);
        });
    },
    function() {
        $('#tag').fadeOut(200, function() {
            $(this).text("@philipxjm").fadeIn(200);
        });
    }
);

$(window).load(function() {
    $("#content").addClass("tri-content")
    $("#tag").addClass("tri-tag")
    $("#name").addClass("tri-name")
})